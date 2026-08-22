/* =========================================================
   計測イベント（GA4 / Google広告）
   仕様書「2. 技術要件 > 計測」に対応。
   - data-track 属性を持つ要素のクリックをイベント送信する
   - gtag が未設定でも動くよう安全に呼び出す（本番は<head>のgtagを有効化）
   ========================================================= */
(function () {
  'use strict';

  // gtag が無い環境（未設定・広告ブロック）でもエラーにしない
  function track(eventName, params) {
    try {
      if (typeof window.gtag === 'function') {
        window.gtag('event', eventName, params || {});
      } else {
        // 開発時の確認用。本番では gtag 有効化により実送信される
        (window.dataLayer = window.dataLayer || []).push(
          Object.assign({ event: eventName }, params)
        );
      }
    } catch (e) { /* 計測失敗でUXを止めない */ }
  }

  // data-track の種別 → GA4イベント名 / パラメータの対応
  //   select_venue  : どちらの館を選択したか
  //   to_form       : フォームページへの遷移（館の別をパラメータに）
  //   line          : LINEボタンのクリック（外部遷移・コンバージョン計測）
  //   tel           : 電話クリック（コンバージョン）
  //   matterport    : マターポート起動
  //   floorplan_pdf : 図面PDFダウンロード
  //   gallery       : 実績写真ギャラリー
  var MAP = {
    select_venue:  { name: 'select_venue' },
    to_form:       { name: 'to_form_click' },
    line:          { name: 'line_click' },
    tel:           { name: 'tel_click' },
    matterport:    { name: 'matterport_open' },
    floorplan_pdf: { name: 'floorplan_download' },
    gallery:       { name: 'gallery_open' },
    official_site: { name: 'official_site_click' }
  };

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-track]');
    if (!el) return;
    var key = el.getAttribute('data-track');
    var def = MAP[key];
    if (!def) return;
    track(def.name, {
      venue: el.getAttribute('data-venue') || 'unknown',
      link_url: el.getAttribute('href') || ''
    });

    // Google広告コンバージョン（LINEクリック）— 既存アカウントの設定に合わせる
    //   LINEボタンは別タブで開くため、遷移を止めずにコンバージョンを送信する
    if (key === 'line') {
      track('conversion', {
        send_to: 'AW-17762210452/m2YsCL_wm6IcEJSl15VC',
        value: 1.0,
        currency: 'JPY'
      });
    }
  }, { passive: true });

  // 360°内覧（マターポート）— サムネイルをクリックでiframeを遅延生成して展開
  //   初期表示ではiframeを読み込まず、LCP/品質スコアを守る
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.mp-thumb');
    if (!btn) return;
    var url = btn.getAttribute('data-mp');
    if (!url) return;
    var wrap = document.createElement('div');
    wrap.className = 'mp-embed';
    var iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.title = '360°バーチャル内覧';
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('allow', 'xr-spatial-tracking; fullscreen');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    wrap.appendChild(iframe);
    btn.replaceWith(wrap);
  });

  // 料金セクション到達（IntersectionObserver・1回だけ）
  var pricing = document.getElementById('pricing');
  if (pricing && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          track('view_pricing', {});
          io.disconnect();
        }
      });
    }, { threshold: 0.4 });
    io.observe(pricing);
  }
})();
