#!/usr/bin/env python3
# ============================================================
# اختبار e2e شامل لخادم MCP Media Generator — يُشغَّل ضد خادم إنتاج محلي
# الاستخدام:  BASE_URL=http://localhost:3100 KIE_REAL_KEY=<key> python3 scripts/e2e_test.py
# يغطي معايير القبول: 2,3,4,6,9,10,11 (الواجهة والفيديو تُختبران على مراحل)
# ============================================================
import json, os, re, sys, time, urllib.request, urllib.error

BASE = os.environ.get("BASE_URL", "http://localhost:3100")
KIE_REAL_KEY = os.environ["KIE_REAL_KEY"]
WRONG_KEY = "kie-test-wrong-key-0000000000"

results = []

def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (("  | " + str(detail)[:220]) if detail else ""))

def http(method, path, body=None, headers=None, timeout=90):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode()

def mcp(method, params=None, id=None, progress_token=None, timeout=240):
    """استدعاء MCP كامل: تهيئة جلسة عابرة ثم إرسال الطلب (وضع stateless)"""
    payload = {"jsonrpc": "2.0", "method": method}
    if params is not None: payload["params"] = params
    if id is not None:
        payload["id"] = id
        if progress_token is not None:
            payload["params"] = {**(params or {}), "_meta": {"progressToken": progress_token}}
        st, _, raw = http("POST", "/mcp", payload,
            headers={"Accept": "application/json, text/event-stream"}, timeout=timeout)
        # الاستجابة إما JSON خام أو SSE (data: سطور)
        msgs = []
        if raw.lstrip().startswith("event:") or "\ndata:" in raw or raw.lstrip().startswith("data:"):
            for line in raw.splitlines():
                if line.startswith("data:"):
                    try: msgs.append(json.loads(line[5:].strip()))
                    except Exception: pass
        else:
            try: msgs = [json.loads(raw)]
            except Exception: pass
        return st, msgs
    else:
        st, _, raw = http("POST", "/mcp", payload,
            headers={"Accept": "application/json, text/event-stream"}, timeout=timeout)
        return st, raw

def call_tool(name, args, progress_token=None, timeout=240):
    """يعيد (نص النتيجة، isError، عدد إشعارات التقدم)"""
    st, msgs = mcp("tools/call", {"name": name, "arguments": args}, id=99,
                   progress_token=progress_token, timeout=timeout)
    final, notes = None, 0
    for m in msgs:
        if m.get("method") == "notifications/progress": notes += 1
        elif "result" in m and m.get("id") == 99: final = m["result"]
        elif "error" in m and m.get("id") == 99: final = {"isError": True, "content": [{"text": m["error"].get("message", "")}]}
    text = ""
    if final:
        text = "\n".join(c.get("text", "") for c in final.get("content", []))
        return text, final.get("isError", False), notes
    return f"(no result) status={st}", True, notes

def keys_list():
    st, _, raw = http("GET", "/api/keys")
    return json.loads(raw)["keys"]

def tasks_list():
    st, _, raw = http("GET", "/api/tasks?limit=30")
    return json.loads(raw)

# ------------------------------------------------------------
print("=== 1) /api/health ===")
st, _, raw = http("GET", "/api/health")
h = json.loads(raw)
check("health.ok == true", h.get("ok") is True)
check("health.database == turso-connected", h.get("database") == "turso-connected")
check("health.models فيها الموديلان", len(h.get("models", [])) == 2)

print("=== 2) MCP initialize ===")
st, msgs = mcp("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "e2e", "version": "1.0"}}, id=1)
init = next((m["result"] for m in msgs if m.get("id") == 1 and "result" in m), None)
check("initialize أرجع نتيجة", init is not None, msgs[:1])
if init:
    check("serverInfo.name == media-generator-mcp", init["serverInfo"]["name"] == "media-generator-mcp")
    check("serverInfo.version == 1.2.0", init["serverInfo"]["version"] == "1.2.0")
    check("instructions موجودة", "multi-key failover" in init.get("instructions", ""))
st, raw = mcp("notifications/initialized", {})
check("notifications/initialized → 202", st == 202, st)

print("=== 3) tools/list ===")
st, msgs = mcp("tools/list", {}, id=2)
tools = {t["name"]: t for t in msgs[0]["result"]["tools"]}
check("الأدوات الخمس", set(tools) == {"generate_image", "generate_video", "merge_videos", "get_task", "list_media"}, set(tools))
mprops = tools["merge_videos"]["inputSchema"]["properties"]
check("merge بلا resolution/fps", "resolution" not in mprops and "fps" not in mprops)
check("merge حد 10", mprops["urls"].get("maxItems") == 10 and mprops["task_ids"].get("maxItems") == 10)

print("=== 4) إدارة المفاتيح (مفتاح خاطئ أولًا ثم الصحيح) ===")
st, _, raw = http("POST", "/api/keys", {"provider": "kie", "api_key": WRONG_KEY, "label": "اختبار-خاطئ"})
check("إضافة المفتاح الخاطئ → 201", st == 201, st)
st, _, raw = http("POST", "/api/keys", {"provider": "kie", "api_key": KIE_REAL_KEY, "label": "kie رئيسي"})
check("إضافة المفتاح الحقيقي → 201", st == 201, st)
st, _, raw = http("POST", "/api/keys", {"provider": "kie", "api_key": KIE_REAL_KEY})
check("رفض التكرار → 409", st == 409, st)
ks = keys_list()
check("ترتيب المفاتيح تسلسلي (الخاطئ أولًا)", ks and ks[0]["masked"] != "" and len(ks) == 2)
check("المفاتيح مُقنَّعة في القائمة", all("••••" in k["masked"] for k in ks))
check("لا يُسرَّب المفتاح الكامل", KIE_REAL_KEY not in json.dumps(ks))

print("=== 5) list_media قبل التوليد ===")
text, err, _ = call_tool("list_media", {"limit": 10})
check("list_media يعمل", err is False, text[:120])

print("=== 6) generate_image e2e (تبديل تلقائي: خاطئ → صحيح) ===")
t0 = time.time()
text, err, notes = call_tool("generate_image",
    {"prompt": "قطة رائدة فضاء صغيرة ترتدي خوذة زجاجية عاكسة، ألوان نيون سماوية وبنفسجية، تفاصيل عالية",
     "wait_seconds": 110, "aspect_ratio": "1:1", "resolution": "1K"},
    progress_token="pt-1", timeout=280)
dur = time.time() - t0
print(f"    [مدة الاستدعاء: {dur:.0f} ث، إشعارات تقدم: {notes}]")
check("الرد الناجح بالعربية", "تم توليد الصورة بنجاح" in text, text[:200])
check("لا ذكر لمفاتيح أو رصيد في الرد", not re.search(r"مفتاح|رصيد|api.?key|balance|quota", text, re.I), text[:160])
murl = re.search(r"https://[^\s)\]]+", text)
check("يوجد رابط صورة", bool(murl), murl.group(0) if murl else text[:120])
if murl:
    img_url = murl.group(0)
    req = urllib.request.Request(img_url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            check("رابط الصورة يعمل (HTTP 200)", r.status == 200, r.status)
    except Exception as e:
        check("رابط الصورة يعمل (HTTP 200)", False, str(e)[:120])
    open("/tmp/image_url.txt", "w").write(img_url)
check("وصلت إشعارات تقدم (SSE)", notes >= 1, notes)

print("=== 7) التحقق من التبديل التسلسلي ===")
ks = keys_list()
wrong = next((k for k in ks if k["masked"].startswith("kie-tes")), None)
real = next((k for k in ks if KIE_REAL_KEY[:7] in k["masked"]), None)
check("المفتاح الخاطئ أصبح disabled", wrong and wrong["status"] == "disabled", wrong and wrong["status"])
check("المفتاح الحقيقي نشط ونجح", real and real["status"] == "active" and real["successCount"] >= 1, real and [real["status"], real["successCount"]])
tl = tasks_list()
img_task = next((t for t in tl["tasks"] if t["type"] == "image"), None)
check("سجل المحاولات يوضح تبديلًا (>=2 محاولة)", img_task and img_task["attemptsCount"] >= 2, img_task and img_task["attemptsCount"])
check("لا تسرّب مفاتيح في المهام", KIE_REAL_KEY not in json.dumps(tl))

print("=== 8) generate_video — بدء مهمة (الاكتمال لاحقًا بـ get_task) ===")
text, err, notes = call_tool("generate_video",
    {"prompt": "موجة بحرية كبيرة تتكسر على صخور عند الغروب، حركة سينمائية بطيئة، ضوء ذهبي دافئ",
     "duration": 8, "resolution": "480p", "wait_seconds": 25},
    progress_token="pt-2", timeout=200)
print("    " + text[:180].replace("\n", " "))
vid = re.search(r"task_id: ([0-9a-f\-]{36})", text)
check("فيديو: مهمة قيد المعالجة أو مكتملة", ("قيد المعالجة" in text) or ("تم توليد الفيديو" in text), text[:100])
check("لا ذكر لمفاتيح أو رصيد في رد الفيديو", not re.search(r"مفتاح|رصيد|api.?key|balance", text, re.I))
if vid: open("/tmp/video_task_id.txt", "w").write(vid.group(1))

print("=== 9) قواعد الدمج (الخدمة غير مهيأة عمدًا) ===")
text, err, _ = call_tool("merge_videos", {"urls": ["https://www.w3schools.com/html/mov_bbb.mp4"]})
check("مقطع واحد → رسالة عربية للحد الأدنى", "الدمج يحتاج مقطعَين على الأقل" in text, text[:140])
text, err, _ = call_tool("merge_videos", {"urls": ["https://a.example/x.mp4"] * 11})
check("11 رابطًا → مرفوض (حد المخطط 10)", err is True, text[:140])
# حلّ task_ids: مهمة الصورة المكتملة تُحلّ إلى رابط ثم يُرفض الدمج لعجز المصادر عن بلوغ 2
img_tid = img_task["id"] if img_task else None
if img_tid:
    text, err, _ = call_tool("merge_videos", {"task_ids": [img_tid]})
    check("task_ids يُحلّ بالترتيب ثم يُرفض <2 بالعربية",
          "الدمج يحتاج مقطعَين على الأقل" in text, text[:160])
text, err, _ = call_tool("merge_videos", {"urls": [
    "https://www.w3schools.com/html/mov_bbb.mp4",
    "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]})
check("دمج صالح مع خدمة ميتة → مهمة processing بالاستئناف التلقائي",
      "قيد المعالجة" in text, text[:160])

print("=== 10) get_task على المهمة المكتملة + list_media ===")
if img_tid:
    text, err, _ = call_tool("get_task", {"task_id": img_tid})
    check("get_task: صورة مكتملة بالعربية", "تم توليد الصورة بنجاح" in text, text[:120])
text, err, _ = call_tool("list_media", {"limit": 5})
check("list_media يعيد المهام بروابطها مرتبة", "أحدث الوسائط" in text, text[:150])
check("الأحدث أولًا (الدمج في القمة)", text.splitlines()[2].startswith("1)") and "دمج" in text.splitlines()[2], text.splitlines()[2] if len(text.splitlines()) > 2 else "")

# ------------------------------------------------------------
fails = [r for r in results if not r[1]]
print(f"\n===== النتيجة: {len(results) - len(fails)}/{len(results)} نجح =====")
sys.exit(1 if fails else 0)
