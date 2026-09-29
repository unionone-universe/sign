/* UNION ONE e-Sign — 공통 스크립트 */
(function () {
  'use strict';

  var API = 'https://script.google.com/macros/s/AKfycbwE9O7RPqJZV4UR-VqYG2bVKt2vPoZSMlVt2ij0k19liucu0i6n3aZgX734imYfl4Rv/exec';

  var COMPANY = {
    name: '(주)유니온 원',
    nameEn: 'UNION ONE Co., Ltd.',
    bizNo: '210-88-03747',
    address: '대구광역시 동구 동화천로77길 46, 3층',
  };

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  }

  /* ---------- 서버 통신 ---------- */
  function api(action, data) {
    var body = JSON.stringify(Object.assign({ action: action }, data || {}));
    return fetch(API, { method: 'POST', body: body, redirect: 'follow' })
      .catch(function () { throw new Error('서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.'); })
      .then(function (res) {
        if (!res.ok) throw new Error('서버 응답 오류 (' + res.status + ')');
        return res.json().catch(function () { throw new Error('서버 응답을 읽지 못했습니다.'); });
      })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || '처리 중 오류가 발생했습니다.');
        return j;
      });
  }

  /* ---------- 변환 ---------- */
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(new Error('파일 변환에 실패했습니다.')); };
      r.readAsDataURL(new Blob([bytes]));
    });
  }

  function sha256Hex(bytes) {
    if (!window.crypto || !crypto.subtle) return Promise.resolve('');
    return crypto.subtle.digest('SHA-256', bytes).then(function (d) {
      return Array.prototype.map.call(new Uint8Array(d), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    });
  }

  /* ---------- PDF 표시 ---------- */
  function renderPdf(container, bytes) {
    container.innerHTML = '';
    var width = Math.max(280, container.clientWidth || 320);
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    return window.pdfjsLib.getDocument({ data: bytes.slice() }).promise.then(function (pdf) {
      var pages = [];
      var chain = Promise.resolve();
      for (var i = 1; i <= pdf.numPages; i++) {
        (function (n) {
          chain = chain.then(function () {
            return pdf.getPage(n).then(function (page) {
              var base = page.getViewport({ scale: 1 });
              var cssScale = width / base.width;
              var vp = page.getViewport({ scale: cssScale * dpr });
              var wrap = document.createElement('div');
              wrap.className = 'pdf-page';
              var canvas = document.createElement('canvas');
              canvas.width = Math.floor(vp.width);
              canvas.height = Math.floor(vp.height);
              wrap.appendChild(canvas);
              container.appendChild(wrap);
              pages.push({ index: n - 1, page: page, wrap: wrap, canvas: canvas, cssViewport: page.getViewport({ scale: cssScale }) });
              return page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
            });
          });
        })(i);
      }
      return chain.then(function () { return { pdf: pdf, pages: pages }; });
    });
  }

  /** PDF 좌표 상자 → 페이지 위 표시 */
  function drawMark(pageInfo, box) {
    var old = pageInfo.wrap.querySelector('.sig-mark');
    if (old) old.remove();
    var r = pageInfo.cssViewport.convertToViewportRectangle([box.x, box.y, box.x + box.w, box.y + box.h]);
    var left = Math.min(r[0], r[2]), top = Math.min(r[1], r[3]);
    var w = Math.abs(r[2] - r[0]), h = Math.abs(r[3] - r[1]);
    var el = document.createElement('div');
    el.className = 'sig-mark';
    var VW = pageInfo.cssViewport.width, VH = pageInfo.cssViewport.height;
    el.style.left = (left / VW * 100) + '%';
    el.style.top = (top / VH * 100) + '%';
    el.style.width = (w / VW * 100) + '%';
    el.style.height = (h / VH * 100) + '%';
    pageInfo.wrap.appendChild(el);
    return el;
  }

  /** PDF 안에서 "(서명 또는 인)" 같은 표시 문구 위치 찾기 (공백 무시) */
  function findMarker(pdf, markers) {
    var targets = markers.map(function (m) { return m.replace(/\s+/g, ''); });
    var found = null;
    var chain = Promise.resolve();
    for (var i = pdf.numPages; i >= 1; i--) {
      (function (n) {
        chain = chain.then(function () {
          if (found) return;
          return pdf.getPage(n).then(function (page) {
            return page.getTextContent().then(function (tc) {
              var s = '';
              var map = [];
              tc.items.forEach(function (it, idx) {
                var str = String(it.str || '');
                for (var k = 0; k < str.length; k++) {
                  if (/\s/.test(str[k])) continue;
                  s += str[k];
                  map.push(idx);
                }
              });
              for (var t = 0; t < targets.length && !found; t++) {
                var at = s.lastIndexOf(targets[t]);
                if (at < 0) continue;
                var used = {};
                for (var q = at; q < at + targets[t].length; q++) used[map[q]] = true;
                var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
                Object.keys(used).forEach(function (key) {
                  var it = tc.items[key];
                  var tr = it.transform;
                  var h = it.height || Math.abs(tr[3]) || 10;
                  var x = tr[4], y = tr[5];
                  x1 = Math.min(x1, x); y1 = Math.min(y1, y - h * 0.2);
                  x2 = Math.max(x2, x + (it.width || 0)); y2 = Math.max(y2, y + h * 0.9);
                });
                found = { page: n - 1, x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
              }
            });
          });
        });
      })(i);
    }
    return chain.then(function () { return found; });
  }

  /* ---------- 화면 도우미 ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  function busy(msg, sub) {
    var el = $('#overlay');
    if (!msg) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'overlay';
      el.className = 'overlay';
      document.body.appendChild(el);
    }
    el.innerHTML = '<div class="spinner"></div><div></div><small></small>';
    el.children[1].textContent = msg;
    el.children[2].textContent = sub || '';
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { toast('복사했습니다.'); });
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('복사했습니다.'); } catch (e) { toast('복사하지 못했습니다. 직접 선택해 복사해 주세요.'); }
    ta.remove();
    return Promise.resolve();
  }

  function downloadBytes(bytes, filename) {
    var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 60000);
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function safeFile(s) { return String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim(); }

  window.UO = {
    API: API, COMPANY: COMPANY, api: api,
    b64ToBytes: b64ToBytes, bytesToB64: bytesToB64, sha256Hex: sha256Hex,
    renderPdf: renderPdf, drawMark: drawMark, findMarker: findMarker,
    $: $, toast: toast, busy: busy, copyText: copyText, downloadBytes: downloadBytes, esc: esc, safeFile: safeFile,
  };
})();
