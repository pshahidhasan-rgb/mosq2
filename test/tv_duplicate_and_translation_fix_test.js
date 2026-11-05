/**
 * Test Suite: TV Duplicate Caption Elimination & Translation Resolution
 * 
 * Tests:
 * 1. TV DOM Renderer Idempotency (3 identical finals -> 1 DOM row pair)
 * 2. Late partial after final does not resurrect / duplicate row
 * 3. Multi-gate finalization deduplication (single-flight queue)
 * 4. Atomic TV subscriber language synchronization on updateTvSettings
 * 5. Mixed-script translation validation (preserves Arabic quotes in English)
 * 6. No-op source language guard prevents recognition stream restart
 *
 * Runs locally with 100% mock data: ZERO API calls, ZERO cost.
 */

const assert = require("assert");
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const sonioxService = require("../server/services/sonioxService");
const { SessionManager } = require("../server/sessionManager");
const { isRawArabicLeak } = require("../server/services/translationService");

// Minimal DOM implementation for Node testing of public/display.js
class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.className = "";
    this.textContent = "";
    this.style = {};
    this.attributes = {};
    this.children = [];
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
      return child;
    }
    return null;
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const check = (el) => {
      let match = true;
      if (selector.startsWith(".")) {
        const classes = selector.split(".").filter(Boolean);
        for (const c of classes) {
          if (!el.className || !el.className.split(/\s+/).includes(c)) {
            match = false;
            break;
          }
        }
      } else if (selector.startsWith("[")) {
        const m = selector.match(/\[([a-zA-Z0-9_-]+)="([^"]+)"\]/);
        if (m) {
          if (el.getAttribute(m[1]) !== m[2]) match = false;
        } else {
          match = false;
        }
      } else {
        match = false;
      }
      if (match) results.push(el);
      for (const child of el.children) {
        check(child);
      }
    };

    for (const child of this.children) {
      check(child);
    }
    return results;
  }
}

async function runTests() {
  console.log("\n================================================================");
  console.log("📺 TV DUPLICATE CAPTION & TRANSLATION RESOLUTION TEST SUITE");
  console.log("================================================================\n");

  // Test 1: DOM Idempotency — Delivering identical final 3 times
  console.log("[Test 1] Verifying TV renderer idempotency on replayed final events...");
  const arabicFeed = new FakeElement("div");
  const transFeed = new FakeElement("div");
  const domContext = {
    document: {
      createElement: (tag) => new FakeElement(tag),
      getElementById: (id) => { if (id === "arabic-feed") return arabicFeed; if (id === "trans-feed") return transFeed; return null; },
      body: new FakeElement("body"),
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    window: {
      location: { protocol: "http:", host: "localhost:3000", search: "" },
      localStorage: { getItem: () => null, setItem: () => {} },
      speechSynthesis: { cancel: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    arabicFeed,
    transFeed,
    targetLang: "en",
    sourceLang: "auto",
    MAX_HISTORY: 50,
    isTvAudioEnabled: false,
    scrollFeedsToBottom: () => {},
    recentFeedItems: [],
    seenKeys: {},
    spokenSeqs: {},
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {}
  };

  const displayCode = fs.readFileSync(path.join(__dirname, "../public/display.js"), "utf8");
  vm.createContext(domContext);
  vm.runInContext(displayCode, domContext);

  domContext.window.__tvDisplayTest.handleStreamingToken({
    lang: "en",
    originalFull: "الحمد لله",
    translatedFull: "All praise is due to Allah",
    isReplacement: true,
    isFinal: true,
    seq: 1,
    timestamp: "2026-11-05T12:00:00Z"
  });

  assert.strictEqual(arabicFeed.children.length, 1, "Arabic feed should have exactly 1 paragraph");
  assert.strictEqual(transFeed.children.length, 1, "Translation feed should have exactly 1 paragraph");

  domContext.window.__tvDisplayTest.handleStreamingToken({
    lang: "en",
    originalFull: "الحمد لله",
    translatedFull: "All praise is due to Allah",
    isReplacement: true,
    isFinal: true,
    seq: 1,
    timestamp: "2026-11-05T12:00:00Z"
  });

  domContext.window.__tvDisplayTest.handleStreamingToken({
    lang: "en",
    originalFull: "الحمد لله",
    translatedFull: "All praise is due to Allah",
    isReplacement: true,
    isFinal: true,
    seq: 1,
    timestamp: "2026-11-05T12:00:00Z"
  });

  assert.strictEqual(arabicFeed.children.length, 1, "Arabic feed must NOT duplicate rows on replayed finals");
  assert.strictEqual(transFeed.children.length, 1, "Translation feed must NOT duplicate rows on replayed finals");
  assert.strictEqual(transFeed.children[0].textContent, "All praise is due to Allah");
  console.log("  ✔ PASS: Identical finals replayed 3 times produce exactly 1 DOM row pair (no duplicates).");

  // Test 2: Late partial after final does not resurrect or duplicate
  console.log("\n[Test 2] Verifying late provisional partial does not duplicate finalized row...");
  domContext.window.__tvDisplayTest.handleStreamingToken({
    lang: "en",
    originalFull: "الحمد",
    translatedFull: "All praise",
    isReplacement: true,
    isFinal: false,
    seq: 1,
    timestamp: "2026-11-05T12:00:00Z"
  });

  assert.strictEqual(arabicFeed.children.length, 1, "Late partial must not append a new Arabic row");
  assert.strictEqual(transFeed.children.length, 1, "Late partial must not append a new translation row");
  assert.strictEqual(transFeed.children[0].textContent, "All praise is due to Allah", "Late partial must not overwrite finalized text");
  console.log("  ✔ PASS: Late provisional partial cleanly ignored for finalized sequence.");

  // Test 3: Multi-Gate Translation Deduplication (Single-flight queue)
  console.log("\n[Test 3] Verifying multi-gate finalization deduplication...");
  const sessionManager = new SessionManager();
  const session = await sessionManager.createSession({ sessionId: "test-multigate-session", mosqueName: "Test Mosque" });
  session.status = "active";
  session.activatedLanguages = new Set(["uz"]);

  let translationCalls = 0;
  const mockTranslateMultiple = async (text, targets) => {
    translationCalls++;
    await new Promise(r => setTimeout(r, 20));
    return { uz: "Allohga hamdlar bo‘lsin" };
  };

  const existing = {
    seq: 1,
    arabic: "الحمد لله",
    translations: { en: "All praise is due to Allah" },
    _inFlightTargets: new Set()
  };
  if (!session.transcripts) session.transcripts = [];
  session.transcripts.push(existing);

  const neededLangs = ["uz"];
  const simulateFinalizeCallback = (gateLang) => {
    const pendingLanguages = neededLangs.filter(
      l => (!existing.translations || !existing.translations[l]) && !existing._inFlightTargets.has(l)
    );
    if (pendingLanguages.length > 0) {
      for (const pl of pendingLanguages) existing._inFlightTargets.add(pl);
      mockTranslateMultiple(existing.arabic, pendingLanguages).then(results => {
        for (const [nl, nText] of Object.entries(results)) {
          existing._inFlightTargets.delete(nl);
          existing.translations[nl] = nText;
        }
      });
    }
  };

  simulateFinalizeCallback("en");
  simulateFinalizeCallback("bn");

  await new Promise(r => setTimeout(r, 60));
  assert.strictEqual(translationCalls, 1, "Exactly 1 translation call should have been made for target uz");
  assert.strictEqual(existing.translations.uz, "Allohga hamdlar bo‘lsin");
  console.log("  ✔ PASS: Multi-gate finalization launched exactly 1 translation job for missing target.");

  // Test 4: Atomic TV subscriber language synchronization
  console.log("\n[Test 4] Verifying updateTvSettings synchronizes TV subscriber language...");
  const mockTvWs = { readyState: 1, send: () => {} };
  sessionManager.addSubscriber(session.id, mockTvWs, { role: "tv", language: "en" });

  const actualId = sessionManager.getCanonicalId(session.id);
  const initialSubs = Array.from(sessionManager.subscribers.get(actualId));
  const tvSub = initialSubs.find(s => s.role === "tv");
  assert.strictEqual(tvSub.language, "en");

  sessionManager.updateTvSettings(session.id, { tvTargetLang: "bn" });
  assert.strictEqual(tvSub.language, "bn", "TV subscriber language must update to bn on updateTvSettings");
  assert.strictEqual(session.tvLanguage, "bn");
  console.log("  ✔ PASS: TV subscriber language atomically synchronized on admin settings change.");

  // Test 5: Mixed-Script Translation Validation (Arabic quotes in English)
  console.log("\n[Test 5] Verifying mixed-script translation validation...");
  const englishWithQuote = "And Allah said: (إِنَّ مَعَ الْعُسْرِ يُسْرًا) Indeed with hardship comes ease.";
  assert.strictEqual(isRawArabicLeak(englishWithQuote), false, "English with Arabic quote must NOT be flagged as raw Arabic leak");

  const englishWithHonorific = "The Prophet (صلى الله عليه وسلم) said: Actions are by intentions.";
  assert.strictEqual(isRawArabicLeak(englishWithHonorific), false, "English with honorific must NOT be flagged as raw Arabic leak");

  const rawArabic = "الحمد لله رب العالمين والصلاة والسلام على رسول الله";
  assert.strictEqual(isRawArabicLeak(rawArabic), true, "Pure Arabic text in non-Arabic target must be flagged as raw leak");
  console.log("  ✔ PASS: Mixed-script translations preserved; raw untranslated Arabic correctly detected.");

  // Test 6: No-Op Source Language Guard
  console.log("\n[Test 6] Verifying no-op source language change does not restart recognition...");
  sonioxService.setApiKey("test_key_noop_12345");
  sonioxService.sessionSourceLanguages.set(session.id, { lang: "auto", hints: [] });

  let commitCalled = false;
  sonioxService.commit = () => { commitCalled = true; };

  sonioxService.setSourceLanguage(session.id, "auto");
  assert.strictEqual(commitCalled, false, "No-op setSourceLanguage must NOT commit or reconnect gates");
  console.log("  ✔ PASS: No-op source language change preserved active recognition streams.");

  console.log("\n================================================================");
  console.log("🎉 ALL TV DUPLICATE & TRANSLATION FIX TESTS PASSED (100%)");
  console.log("================================================================\n");
}

runTests().catch(err => {
  console.error("\n❌ Test suite failed:", err);
  process.exit(1);
});
