#!/usr/bin/env python3
# اختبار التبديل التسلسلي الصارم (معيار القبول 6) — مفتاح خاطئ أولًا ثم الصحيح
import json, os, re, sys, time, urllib.request, urllib.error

BASE = os.environ.get("BASE_URL", "http://localhost:3100")
KIE_REAL_KEY = os.environ["KIE_REAL_KEY"]
WRONG_KEY = "kie-test-wrong-key-0000000000"
results = []

def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (("  | " + str(detail)[:200]) if detail else ""))

def http(method, path, body=None, headers=None, timeout=300):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode()

def call_tool(name, args, timeout=300):
    payload = {"jsonrpc": "2.0", "id": 7, "method": "tools/call",
               "params": {"name": name, "arguments": args, "_meta": {"progressToken": "pt-f"}}}
    st, _, raw = http("POST", "/mcp", payload, headers={"Accept": "application/json, text/event-stream"}, timeout=timeout)
    final, notes = None, 0
    for line in raw.splitlines():
        if line.startswith("data:"):
            try: m = json.loads(line[5:].strip())
            except Exception: continue
            if m.get("method") == "notifications/progress": notes += 1
            elif m.get("id") == 7: final = m.get("result") or m.get("error")
    text = "\n".join(c.get("text", "") for c in (final or {}).get("content", [])) if final else str(raw)[:200]
    return text, bool((final or {}).get("isError")), notes

# 1) المفتاح الخاطئ أولًا ثم الحقيقي — الترتيب التسلسلي حسب الإضافة
st, _, _ = http("POST", "/api/keys", {"provider": "kie", "api_key": WRONG_KEY, "label": "اختبار-خاطئ"})
check("المفتاح الخاطئ أُضيف أولًا (201)", st == 201, st)
st, _, _ = http("POST", "/api/keys", {"provider": "kie", "api_key": KIE_REAL_KEY, "label": "kie رئيسي"})
check("المفتاح الحقيقي أُضيف ثانيًا (201)", st == 201, st)
st, _, raw = http("GET", "/api/keys")
ks = json.loads(raw)["keys"]
order = [k["masked"] for k in ks]
check("الترتيب التسلسلي: الخاطئ قبل الحقيقي", order.index(next(m for m in order if m.startswith("kie-tes"))) < order.index(next(m for m in order if KIE_REAL_KEY[:7] in m)), order)

# 2) توليد صورة — يجب أن يفشل على الخاطئ (401 → disabled) وينجح على الثاني بنفس task_id
t0 = time.time()
text, err, notes = call_tool("generate_image", {
    "prompt": "منارة عالية على جرف صخري تحت شفق قطبي بنفسجي وسماوي، سماء مليئة بالنجوم، إضاءة سينمائية",
    "wait_seconds": 100}, timeout=300)
print(f"    [المدة: {time.time()-t0:.0f} ث، إشعارات: {notes}]")
check("النجاح بالعربية رغم المفتاح الخاطئ الأول", "تم توليد الصورة بنجاح" in text, text[:180])
check("الرد خالٍ من أي ذكر لمفاتيح/رصيد", not re.search(r"مفتاح|رصيد|api.?key|balance|unauthorized", text, re.I), text[:150])
murl = re.search(r"https://[^\s)\]]+", text)
if murl:
    try:
        with urllib.request.urlopen(urllib.request.Request(murl.group(0), method="HEAD"), timeout=30) as r:
            check("رابط الصورة الجديدة يعمل", r.status == 200, r.status)
    except Exception as e:
        check("رابط الصورة الجديدة يعمل", False, str(e)[:100])

# 3) التحقق من الحالات: الخاطئ disabled، والمحاولات >=2 لنفس task_id
st, _, raw = http("GET", "/api/keys")
ks = json.loads(raw)["keys"]
wrong = next((k for k in ks if k["masked"].startswith("kie-tes")), None)
real = next((k for k in ks if KIE_REAL_KEY[:7] in k["masked"]), None)
check("المفتاح الخاطئ صار disabled تلقائيًا", wrong and wrong["status"] == "disabled", wrong and wrong["status"])
check("المفتاح الحقيقي نشط ونجحت عليه المحاولة", real and real["status"] == "active", real and real["status"])

st, _, raw = http("GET", "/api/tasks?limit=10")
tl = json.loads(raw)["tasks"]
img = next((t for t in tl if t["type"] == "image" and t["status"] == "completed" and "منارة" in (t.get("prompt") or "")), None)
check("مهمة الصورة مكتملة", img is not None, [t["type"] + ":" + t["status"] for t in tl])
check("عدد المحاولات >= 2 (تبديل حقيقي)", img and img["attemptsCount"] >= 2, img and img["attemptsCount"])
if img:
    st, _, raw = http("GET", "/api/tasks?limit=10")
    tid = img["id"]
    open("/tmp/image_task_id.txt", "w").write(tid)
    # استخراج تفاصيل المحاولات من استجابة get_task عبر MCP
    text, err, _ = call_tool("get_task", {"task_id": tid})
    check("get_task يعرض النتيجة النهائية فقط للعميل", "تم توليد الصورة بنجاح" in text, text[:120])

fails = [r for r in results if not r[1]]
print(f"\n===== النتيجة: {len(results)-len(fails)}/{len(results)} نجح =====")
sys.exit(1 if fails else 0)
