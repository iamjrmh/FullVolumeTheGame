/* ============================================================================
   ads.js - Google AdSense loader
   Any element with data-ad="<name>" is a slot. A slot only renders when it
   has an ad unit ID (its own or DEFAULT_UNIT; none = the slot stays collapsed
   and the ad script is never fetched), and never in an iframe or the Tauri apps.
   On localhost every slot gets a same-sized mock ad instead, because AdSense
   never serves there; that is how the layout gets previewed.
   Pair with css/ads.css.
   ============================================================================ */
(function () {
  "use strict";

  const AD_CLIENT = "ca-pub-5666603521655648";

  /* One responsive display ad unit (AdSense > Ads > By ad unit) serves every
     slot. Leave it empty and every slot stays collapsed and the ad script is
     never fetched - that is the off switch. */
  const DEFAULT_UNIT = "9518874666";

  /* Optional per-slot units, only for per-placement reports in AdSense. A slot
     missing here, or left empty, uses DEFAULT_UNIT. */
  const AD_UNITS = {
    homeAbout: "",        // home, between About and the features
    home: "",             // home, between the screenshots and Sing together
    homeFaq: "",          // home, between the song library and the questions
    marketplaceTop: "",   // marketplace, above the chart list
    marketplace: "",      // marketplace, under the chart list
    marketplaceEnd: "",   // marketplace, above the footer
    charterSteps: "",     // charter page, between the steps and the features
    charter: "",          // charter page, between the screenshots and its FAQ
    charterEnd: "",       // charter page, above the download panel
    communityTop: "",     // community, between the rooms and why
    community: "",        // community, between what's inside and the charters
    communityEnd: "",     // community, above the footer
    faqTop: "",           // /faq/, before the second group
    faq: "",              // /faq/, before the fourth group
    faqEnd: "",           // /faq/, before the last group
    changelogTop: "",     // /changelog/, above the releases
    changelogFeed: "",    // /changelog/, after every third release (changelog.js)
    changelog: "",        // /changelog/, under the releases
    guideTop: "",         // the four guide articles, after the opening section
    guide: "",            // the four guide articles, mid-article
    guideEnd: "",         // the four guide articles, above the download box
  };

  const AD_SCRIPT_SRC = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + AD_CLIENT;
  const IS_LOCAL_PREVIEW = ["localhost", "127.0.0.1"].includes(location.hostname);
  const ROOT = new URL("..", document.currentScript.src).href;

  function isInsideApp() {
    try {
      if (window.self !== window.top) return true;
      if (window.__TAURI__ || window.__TAURI_INTERNALS__) return true;
    } catch (e) {
      return true;
    }
    return false;
  }

  function loadAdScript() {
    if (document.querySelector('script[src^="https://pagead2.googlesyndication.com/"]')) return;
    const s = document.createElement("script");
    s.async = true;
    s.src = AD_SCRIPT_SRC;
    s.crossOrigin = "anonymous";
    s.onerror = () => console.warn("[ads] ad script blocked or failed to load");
    document.head.appendChild(s);
  }

  function buildMockAd() {
    const mock = document.createElement("div");
    mock.className = "ad-mock";
    mock.innerHTML =
      '<div class="ad-mock__img"></div>' +
      '<div class="ad-mock__text"><strong>Example advertiser</strong>' +
      "<span>This is where a real ad would appear.</span></div>" +
      '<span class="ad-mock__cta">Learn more</span>';
    return mock;
  }

  function buildSlot(el, unitId) {
    const head = document.createElement("div");
    head.className = "ad-slot__head";
    head.innerHTML = '<span>Advertisement</span><a href="' + ROOT + 'privacy/#ads">Why ads?</a>';

    if (IS_LOCAL_PREVIEW) {
      el.replaceChildren(head, buildMockAd());
      el.classList.add("is-live");
      return;
    }

    const ins = document.createElement("ins");
    ins.className = "adsbygoogle";
    ins.dataset.adClient = AD_CLIENT;
    ins.dataset.adSlot = unitId;
    ins.dataset.adFormat = "auto";
    ins.dataset.fullWidthResponsive = "true";

    el.replaceChildren(head, ins);
    el.classList.add("is-live");

    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (e) {
      console.warn("[ads] slot failed to initialise", el.dataset.ad, e);
      el.classList.remove("is-live");
    }
  }

  const BLOCKED = isInsideApp();

  function unitFor(name) {
    return AD_UNITS[name] || DEFAULT_UNIT;
  }

  function fill(el) {
    if (BLOCKED || el.classList.contains("is-live")) return;
    const unitId = unitFor(el.dataset.ad);
    if (!unitId && !IS_LOCAL_PREVIEW) return;
    if (!IS_LOCAL_PREVIEW) loadAdScript();
    buildSlot(el, unitId);
  }

  // Pages that draw slots after load (the changelog feed) fill them through this.
  window.FvAds = { fill: fill };

  function init() {
    document.querySelectorAll("[data-ad]").forEach(fill);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
