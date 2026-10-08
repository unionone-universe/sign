/* UNION ONE e-Sign — 공통 스크립트 (견적서·계약서 공용) */
(function () {
  'use strict';

  var API = 'https://script.google.com/macros/s/AKfycbwE9O7RPqJZV4UR-VqYG2bVKt2vPoZSMlVt2ij0k19liucu0i6n3aZgX734imYfl4Rv/exec';

  var COMPANY = {
    name: '(주)유니온 원',
    nameEn: 'UNION ONE Co., Ltd.',
    bizNo: '210-88-03747',
    address: '대구광역시 동구 동화천로77길 46, 3층',
  };

  var FONT = '"Noto Sans KR", "Noto Sans CJK KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

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
        if (!j.ok) {
          var e = new Error(j.error || '처리 중 오류가 발생했습니다.');
          e.code = j.code || '';
          throw e;
        }
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

  function canvasToBytes(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) return reject(new Error('이미지 생성에 실패했습니다.'));
        blob.arrayBuffer().then(function (buf) { resolve(new Uint8Array(buf)); }, reject);
      }, 'image/png');
    });
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('이미지를 불러오지 못했습니다.')); };
      img.src = src;
    });
  }

  /* ---------- 문서 종류별 문구 ---------- */
  var DOC = {
    '견적서': {
      label: '견적서',
      agree: '위 견적서의 공사 내용과 금액을 모두 확인하였으며, 이에 동의하여 전자서명합니다.',
      agreeShort: '견적서의 공사 내용과 금액을 확인하고 이에 동의함',
    },
    '계약서': {
      label: '계약서',
      agree: '위 계약서의 내용을 모두 확인하였으며, 전자서명으로 계약을 체결하는 것에 동의합니다. 전자서명된 계약서는 서면 계약서와 동일한 효력을 가집니다.',
      agreeShort: '계약서 내용을 모두 확인하였으며 전자서명으로 계약을 체결하는 것에 동의함',
    },
    '문서': {
      label: '문서',
      agree: '위 문서의 내용을 모두 확인하였으며, 이에 동의하여 전자서명합니다.',
      agreeShort: '문서 내용을 모두 확인하고 이에 동의함',
    },
  };
  function docInfo(type) { return DOC[type] || DOC['문서']; }

  /** '2026-11-07 17:00:00' → '2026년 11월 7일' */
  function koDate(s) {
    var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? (+m[1]) + '년 ' + (+m[2]) + '월 ' + (+m[3]) + '일' : '';
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

  /** PDF 좌표 상자 → 페이지 위 표시 (cls 별로 하나씩) */
  function drawMark(pageInfo, box, cls, label) {
    cls = cls || 'sig-mark';
    var old = pageInfo.wrap.querySelector('.' + cls);
    if (old) old.remove();
    var r = pageInfo.cssViewport.convertToViewportRectangle([box.x, box.y, box.x + box.w, box.y + box.h]);
    var left = Math.min(r[0], r[2]), top = Math.min(r[1], r[3]);
    var w = Math.abs(r[2] - r[0]), h = Math.abs(r[3] - r[1]);
    var el = document.createElement('div');
    el.className = 'mark ' + cls;
    el.setAttribute('data-label', label || '서명');
    var VW = pageInfo.cssViewport.width, VH = pageInfo.cssViewport.height;
    el.style.left = (left / VW * 100) + '%';
    el.style.top = (top / VH * 100) + '%';
    el.style.width = (w / VW * 100) + '%';
    el.style.height = (h / VH * 100) + '%';
    pageInfo.wrap.appendChild(el);
    return el;
  }

  function clearMarks(render) {
    if (!render) return;
    render.pages.forEach(function (p) {
      Array.prototype.forEach.call(p.wrap.querySelectorAll('.mark'), function (m) { m.remove(); });
    });
  }

  /** 서명 자리를 페이지 위에 표시 (서명 + 성명 기재 자리) */
  function showSpot(render, spot) {
    clearMarks(render);
    if (!render || !spot) return null;
    var pi = render.pages[spot.page];
    if (!pi) return null;
    var el = drawMark(pi, { x: spot.x - 4, y: spot.y - 3, w: spot.w + 8, h: spot.h + 6 }, 'sig-mark', '서명');
    if (spot.name) {
      var n = spot.name;
      drawMark(pi, { x: n.x1, y: n.y - n.size * 0.35, w: n.x2 - n.x1, h: n.size * 1.5 }, 'name-mark', '성명');
    }
    return el;
  }

  /* ---------- 서명 자리 자동 찾기 ---------- */

  var MARKERS = [
    { t: '(서명또는인)', kind: 'sign', pri: 0 },
    { t: '(서명또는날인)', kind: 'sign', pri: 0 },
    { t: '(서명)', kind: 'sign', pri: 1 },
    { t: '(인)', kind: 'in', pri: 2 },
  ];
  // 고객(서명자) 쪽을 가리키는 칸 제목 — 글자만 따로 있는 칸 제목과 정확히 같을 때만 사용
  var ROLES = ['발주자', '발주처', '도급인', '의뢰인', '위임인', '주문자', '구매자', '고객', '갑'];
  // 우리 회사 쪽 서명란을 고르지 않도록 걸러내는 글자
  var OURS = /김정훈|유니온|UNIONONE|시공자|수급인|수임인/i;

  function strip(s) { return String(s || '').replace(/\s+/g, ''); }

  function readPages(pdf) {
    var pages = [];
    var chain = Promise.resolve();
    for (var i = 1; i <= pdf.numPages; i++) {
      (function (n) {
        chain = chain.then(function () {
          return pdf.getPage(n).then(function (page) {
            return page.getTextContent().then(function (tc) {
              var items = [];
              tc.items.forEach(function (it) {
                var str = String(it.str || '');
                if (!str.trim()) return;
                var tr = it.transform;
                items.push({
                  str: str, s: strip(str),
                  x: tr[4], y: tr[5],
                  w: it.width || 0,
                  h: it.height || Math.abs(tr[3]) || 10,
                });
              });
              pages.push({ index: n - 1, items: items });
            });
          });
        });
      })(i);
    }
    return chain.then(function () { return pages; });
  }

  function lineText(pg, y) {
    return pg.items.filter(function (it) { return Math.abs(it.y - y) < 2; })
      .sort(function (a, b) { return a.x - b.x; })
      .map(function (it) { return it.s; }).join('');
  }

  function findCandidates(pg) {
    var s = '';
    var map = [];
    pg.items.forEach(function (it, idx) {
      for (var k = 0; k < it.str.length; k++) {
        if (/\s/.test(it.str[k])) continue;
        s += it.str[k];
        map.push({ i: idx, k: k });
      }
    });
    var taken = [];
    var out = [];
    MARKERS.forEach(function (m) {
      var from = 0, at;
      while ((at = s.indexOf(m.t, from)) >= 0) {
        from = at + 1;
        var clash = false;
        for (var q = at; q < at + m.t.length; q++) if (taken[q]) clash = true;
        if (clash) continue;
        var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, base = null, size = 10;
        for (var p = at; p < at + m.t.length; p++) {
          taken[p] = true;
          var c = map[p], it = pg.items[c.i], L = it.str.length || 1;
          x1 = Math.min(x1, it.x + it.w * (c.k / L));
          x2 = Math.max(x2, it.x + it.w * ((c.k + 1) / L));
          y1 = Math.min(y1, it.y - it.h * 0.2);
          y2 = Math.max(y2, it.y + it.h * 0.9);
          if (base === null) { base = it.y; size = it.h; }
        }
        out.push({ page: pg.index, x: x1, y: y1, w: x2 - x1, h: y2 - y1, kind: m.kind, pri: m.pri, base: base, size: size, order: at });
      }
    });
    return out;
  }

  /** 서명 자리 왼쪽에 "성명" 칸이 비어 있으면 그 자리를 성명 기재 자리로 사용 */
  function nameArea(pg, c) {
    var line = pg.items.filter(function (it) {
      return Math.abs(it.y - c.base) < 1.5 && it.x + it.w <= c.x + 0.5;
    }).sort(function (a, b) { return a.x - b.x; });
    var label = null, labelIdx = -1;
    line.forEach(function (it, i) { if (/^(성명|이름)/.test(it.s)) { label = it; labelIdx = i; } });
    if (!label) return null;
    var rest = label.s.replace(/^(성명|이름)[:：]?/, '').replace(/[_\-.·:：]/g, '');
    if (rest) return null;                                   // 이미 이름이 인쇄되어 있음
    for (var i = labelIdx + 1; i < line.length; i++) {
      if (line[i].s.replace(/[_\-.·:：]/g, '')) return null; // 사이에 다른 글자가 있음
    }
    var x1 = label.x + label.w + 6, x2 = c.x - 4;
    if (x2 - x1 < 30) return null;
    return { x1: x1, x2: x2, y: c.base, size: Math.max(7, Math.min(14, c.size)) };
  }

  /**
   * 문서 종류와 고객 서명 자리를 찾습니다.
   * 반환: { docType, spot:{page,x,y,w,h,kind,name}|null, how }
   */
  function findSignSpot(pdf) {
    return readPages(pdf).then(function (pages) {
      // 문서 종류 (1쪽에서 먼저 나오는 쪽)
      var first = pages[0] ? pages[0].items.map(function (it) { return it.s; }).join('') : '';
      var iq = first.indexOf('견적서'), ic = first.indexOf('계약서');
      var docType = iq < 0 && ic < 0 ? '문서' : (ic < 0 || (iq >= 0 && iq < ic)) ? '견적서' : '계약서';

      var cands = [];
      pages.forEach(function (pg) { cands = cands.concat(findCandidates(pg)); });

      var chosen = null, how = '';

      // 1) 고객 쪽 칸 제목(발주자·갑 등) 아래에서 가장 가까운 서명 자리
      var best = Infinity;
      pages.forEach(function (pg) {
        pg.items.forEach(function (it) {
          if (ROLES.indexOf(it.s) < 0) return;
          var ax = it.x + it.w / 2;
          cands.forEach(function (c) {
            if (c.page !== pg.index || c.base >= it.y) return;
            var score = Math.abs(c.x + c.w / 2 - ax) + (it.y - c.base) * 0.6;
            if (score < best) { best = score; chosen = c; how = it.s + ' 서명란'; }
          });
        });
      });

      // 2) 없으면 우리 회사 서명란을 뺀 나머지 중에서 고름
      if (!chosen) {
        var rest = cands.filter(function (c) { return !OURS.test(lineText(pages[c.page], c.base)); });
        rest.sort(function (a, b) { return a.pri - b.pri || b.page - a.page || b.order - a.order; });
        if (rest.length) { chosen = rest[0]; how = '서명 표시 문구'; }
      }

      if (!chosen) return { docType: docType, spot: null, how: '' };

      var spot = { page: chosen.page, x: chosen.x, y: chosen.y, w: chosen.w, h: chosen.h, kind: chosen.kind, name: null };
      spot.name = nameArea(pages[chosen.page], chosen);
      return { docType: docType, spot: spot, how: how };
    });
  }

  /* ---------- 서명·성명 배치 (미리보기와 완료본이 같은 계산을 씀) ---------- */

  /** 글자를 고해상도 이미지로 (PDF에 넣을 성명) */
  function textImage(text, pt) {
    var K = 8;
    var px = pt * K;
    var font = '400 ' + px + 'px ' + FONT;
    var c = document.createElement('canvas');
    var g = c.getContext('2d');
    g.font = font;
    var m = g.measureText(text);
    var asc = Math.ceil(m.actualBoundingBoxAscent || px * 0.8) + K;
    var desc = Math.ceil(m.actualBoundingBoxDescent || px * 0.2) + K;
    var left = Math.ceil(m.actualBoundingBoxLeft || 0) + K;
    var right = Math.ceil(m.actualBoundingBoxRight || m.width) + K;
    c.width = Math.max(1, left + right);
    c.height = Math.max(1, asc + desc);
    g = c.getContext('2d');
    g.font = font;
    g.fillStyle = '#111111';
    g.textBaseline = 'alphabetic';
    g.fillText(text, left, asc);
    return { canvas: c, wPt: c.width / K, hPt: c.height / K, descPt: desc / K };
  }

  /**
   * spot: 서명 자리, sigW/sigH: 서명 이미지 크기(px), nameImg: textImage 결과(없으면 null)
   * 반환: { sig:{x,y,w,h}, name:{x,y,w,h}|null } — PDF 좌표
   */
  function layout(spot, sigW, sigH, nameImg) {
    var lim = spot.kind === 'in' ? { w: 80, h: 30 }
      : spot.kind === 'sign' ? { w: Math.max(120, spot.w * 2), h: 40 }
      : { w: 120, h: 36 };
    var ratio = sigW / Math.max(1, sigH);
    var h = lim.h, w = h * ratio;
    if (w > lim.w) { w = lim.w; h = w / ratio; }
    var cx = spot.x + spot.w / 2 - (spot.kind === 'in' ? 6 : 0);
    var cy = spot.y + spot.h / 2;
    var sig = { x: cx - w / 2, y: cy - h / 2, w: w, h: h };

    var name = null;
    if (spot.name && nameImg) {
      var n = spot.name;
      var right = Math.min(n.x2, sig.x - 4);
      if (right - n.x1 < 24) right = n.x2;
      var f = Math.min(1, (right - n.x1) / nameImg.wPt);
      var nw = nameImg.wPt * f, nh = nameImg.hPt * f;
      var nx = (n.x1 + n.x2) / 2 - nw / 2;
      if (nx + nw > right) nx = right - nw;
      if (nx < n.x1) nx = n.x1;
      name = { x: nx, y: n.y - nameImg.descPt * f, w: nw, h: nh };
    }
    return { sig: sig, name: name };
  }

  /** 미리보기: 서명 자리 주변을 확대해 서명·성명을 얹은 그림 */
  function renderSignPreview(canvas, pageObj, spot, lay, sigImg, nameImg) {
    var base = pageObj.getViewport({ scale: 1 });
    var rects = [lay.sig, { x: spot.x, y: spot.y, w: spot.w, h: spot.h }];
    if (lay.name) rects.push(lay.name);
    if (spot.name) rects.push({ x: spot.name.x1, y: spot.name.y - 4, w: spot.name.x2 - spot.name.x1, h: 8 });
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    rects.forEach(function (r) {
      x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
      x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
    });
    var vb = pageObj.view; // [x0, y0, x1, y1]
    x1 = Math.max(vb[0], x1 - 58); x2 = Math.min(vb[2], x2 + 58);
    y1 = Math.max(vb[1], y1 - 30); y2 = Math.min(vb[3], y2 + 30);

    var targetW = Math.min(1100, Math.max(600, (canvas.parentNode.clientWidth || 360) * Math.min(window.devicePixelRatio || 1, 2.5)));
    var s = targetW / (x2 - x1);
    var full = pageObj.getViewport({ scale: s });
    var q0 = full.convertToViewportRectangle([x1, y1, x2, y2]);
    var vp = pageObj.getViewport({ scale: s, offsetX: -Math.min(q0[0], q0[2]), offsetY: -Math.min(q0[1], q0[3]) });
    canvas.width = Math.round(Math.abs(q0[2] - q0[0]));
    canvas.height = Math.round(Math.abs(q0[3] - q0[1]));
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return pageObj.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
      function put(img, r) {
        var q = vp.convertToViewportRectangle([r.x, r.y, r.x + r.w, r.y + r.h]);
        ctx.drawImage(img, Math.min(q[0], q[2]), Math.min(q[1], q[3]), Math.abs(q[2] - q[0]), Math.abs(q[3] - q[1]));
      }
      if (lay.name && nameImg) put(nameImg.canvas, lay.name);
      put(sigImg, lay.sig);
    });
  }

  /** 글꼴 미리 불러오기 (Noto Sans KR은 글자 구간별로 나뉘어 있어 실제 글자를 넘겨야 함) */
  function loadFonts(text, weights) {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    var jobs = (weights || [400]).map(function (w) {
      return document.fonts.load(w + ' 32px "Noto Sans KR"', text || '가').catch(function () {});
    });
    var timeout = new Promise(function (r) { setTimeout(r, 4000); });
    return Promise.race([Promise.all(jobs), timeout]);
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
      return navigator.clipboard.writeText(text).then(function () { toast('복사했습니다.'); }, function () { return fallbackCopy(text); });
    }
    return fallbackCopy(text);
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('복사했습니다.'); } catch (e) { toast('복사하지 못했습니다. 직접 선택해 복사해 주세요.'); }
    ta.remove();
    return Promise.resolve();
  }

  /** 휴대폰·태블릿이면 공유 창(카카오톡 선택), 아니면 false */
  function canShare() {
    var touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    return !!(navigator.share && touch);
  }
  function share(text) {
    if (!canShare()) return copyText(text);
    return navigator.share({ text: text }).catch(function (e) {
      if (e && e.name === 'AbortError') return;
      return copyText(text);
    });
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
    API: API, COMPANY: COMPANY, FONT: FONT, api: api,
    b64ToBytes: b64ToBytes, bytesToB64: bytesToB64, sha256Hex: sha256Hex,
    canvasToBytes: canvasToBytes, loadImage: loadImage,
    docInfo: docInfo, koDate: koDate,
    renderPdf: renderPdf, drawMark: drawMark, clearMarks: clearMarks, showSpot: showSpot,
    findSignSpot: findSignSpot, textImage: textImage, layout: layout, renderSignPreview: renderSignPreview, loadFonts: loadFonts,
    $: $, toast: toast, busy: busy, copyText: copyText, canShare: canShare, share: share,
    downloadBytes: downloadBytes, esc: esc, safeFile: safeFile,
  };
})();
