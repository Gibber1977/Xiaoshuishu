// ==UserScript==
// @name         水源社区小红书模式 Smart (智能配图+设置面板)
// @namespace    http://tampermonkey.net/
// @version      4.12
// @description  超级智能版：自动提取帖子正文图片作为封面，内置设置面板，支持暗色模式，针对水源优化的关键词高亮
// @author       Gemini Agent & JackyLiii (LinuxDo Original)
// @match        https://shuiyuan.sjtu.edu.cn/*
// @match        https://shuiyuan.sjtu.edu.cn/latest*
// @match        https://shuiyuan.sjtu.edu.cn/top*
// @match        https://shuiyuan.sjtu.edu.cn/categories*
// @match        https://shuiyuan.sjtu.edu.cn/tag/*
// @icon         https://shuiyuan.sjtu.edu.cn/favicon.ico
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    if (window.__xhsShuiyuanLoaded) return;
    window.__xhsShuiyuanLoaded = true;

    const VERSION = '4.12';

    /* ============================================
     * 0. 早期防闪烁逻辑
     * ============================================ */
    const EarlyStyles = {
        injected: false,
        styleId: 'xhs-early-styles',
        
        inject() {
            if (this.injected) return;
            this.injected = true;

            let enabled = true;
            try {
                const saved = localStorage.getItem('xhs_enabled_cache');
                if (saved !== null) enabled = saved === 'true';
            } catch {}

            if (!enabled) return;

            // 仅在“话题列表页”启用早期防闪烁，避免影响消息/个人页等含 `.topic-list` 的页面。
            const path = window.location.pathname;
            const isListLikePage =
                path === '/' ||
                path.startsWith('/latest') ||
                path.startsWith('/top') ||
                path.startsWith('/categories') ||
                path.startsWith('/tag/') ||
                path.startsWith('/c/');
            if (!isListLikePage) return;

            // 简单的暗色检测
            const isDark = document.cookie.includes('theme=dark') || 
                           (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);

            const css = `
                /* 隐藏原生列表防止闪烁 */
                body.xhs-early .topic-list, 
                body.xhs-early .topic-list-header {
                    opacity: 0 !important;
                    pointer-events: none !important;
                    position: absolute !important;
                }
                body.xhs-early {
                    background: ${isDark ? '#1a1a1a' : '#f5f5f7'} !important;
                }
            `;
            const style = document.createElement('style');
            style.id = this.styleId;
            style.textContent = css;
            (document.head || document.documentElement).appendChild(style);
            
            if (document.body) document.body.classList.add('xhs-early');
            else document.addEventListener('DOMContentLoaded', () => document.body.classList.add('xhs-early'));
        },

        remove() {
            document.getElementById(this.styleId)?.remove();
            document.body?.classList.remove('xhs-early');
        },
        
        cacheEnabled(val) { localStorage.setItem('xhs_enabled_cache', val); }
    };
    EarlyStyles.inject();

    /* ============================================
     * 1. 配置模块
     * ============================================ */
    const Config = {
        KEY: 'xhs_shuiyuan_config',
        defaults: {
            enabled: true,
            themeColor: '#C8102E', // 交大红
            showStats: true,
            darkMode: 'auto', 
            cardStagger: true, // 错落布局
            columnCount: 5, // 列数（桌面端基准）
            cacheEnabled: true, // 跨页面缓存
            cacheTtlMinutes: 60, // 缓存有效期（分钟）
            cacheMaxEntries: 300, // 缓存条目上限
            debugMode: false // 调试模式（仅用于排查问题）
        },
        themes: {
            '交大红': '#C8102E',
            '水源蓝': '#0085CA', // 稍微亮一点的蓝
            '活力橙': '#fa541c',
            '清新绿': '#52c41a',
            '神秘紫': '#722ed1',
            '少女粉': '#eb2f96'
        },
        get() {
            try {
                const cfg = { ...this.defaults, ...JSON.parse(GM_getValue(this.KEY, '{}')) };
                // 基本校验/归一化（避免脏数据导致样式/逻辑异常）
                cfg.columnCount = Math.min(8, Math.max(2, parseInt(cfg.columnCount, 10) || this.defaults.columnCount));
                cfg.cacheTtlMinutes = Math.min(24 * 60, Math.max(1, parseInt(cfg.cacheTtlMinutes, 10) || this.defaults.cacheTtlMinutes));
                cfg.cacheMaxEntries = Math.min(5000, Math.max(50, parseInt(cfg.cacheMaxEntries, 10) || this.defaults.cacheMaxEntries));
                cfg.cacheEnabled = Boolean(cfg.cacheEnabled);
                cfg.showStats = Boolean(cfg.showStats);
                cfg.enabled = Boolean(cfg.enabled);
                cfg.cardStagger = Boolean(cfg.cardStagger);
                cfg.debugMode = Boolean(cfg.debugMode);
                return cfg;
            } catch { return this.defaults; }
        },
        set(k, v) {
            const cfg = this.get();
            cfg[k] = v;
            GM_setValue(this.KEY, JSON.stringify(cfg));
        },
        reset() {
            GM_setValue(this.KEY, JSON.stringify(this.defaults));
        }
    };

    /* ============================================
     * 2. 工具模块
     * ============================================ */
    const Utils = {
        hexToRgb(hex) {
            const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
            return r ? `${parseInt(r[1], 16)}, ${parseInt(r[2], 16)}, ${parseInt(r[3], 16)}` : '200, 16, 46';
        },
        formatNumber(n) {
            n = parseInt(n) || 0;
            if (n >= 10000) return (n/10000).toFixed(1) + 'w';
            if (n >= 1000) return (n/1000).toFixed(1) + 'k';
            return n;
        },
        parseCount(val) {
            if (val === null || val === undefined) return 0;
            const raw = String(val).trim();
            if (!raw) return 0;
            if (raw === '-' || raw === '—') return 0;

            const s = raw
                .replace(/,/g, '')
                .replace(/\s+/g, '')
                .toLowerCase();

            // 1.8k / 2k / 1.2m
            const km = /^(\d+(?:\.\d+)?)([km])$/u.exec(s);
            if (km) {
                const n = parseFloat(km[1]);
                if (!Number.isFinite(n)) return 0;
                return Math.round(n * (km[2] === 'm' ? 1_000_000 : 1_000));
            }

            // 1.2w / 3w 或 1.2万
            const w = /^(\d+(?:\.\d+)?)(w|万)$/u.exec(s);
            if (w) {
                const n = parseFloat(w[1]);
                if (!Number.isFinite(n)) return 0;
                return Math.round(n * 10_000);
            }

            const n = parseInt(s, 10);
            return Number.isFinite(n) ? n : 0;
        },
        debounce(fn, delay) {
            let timer;
            return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), delay); };
        },
        getListKey() {
            return `${window.location.pathname}${window.location.search || ''}`;
        },
        saveListScrollState(state) {
            try {
                const key = this.getListKey();
                const payload = {
                    y: Math.max(0, Math.floor(state?.y ?? window.scrollY ?? 0)),
                    tid: state?.tid ? String(state.tid) : '',
                    ts: Date.now()
                };
                sessionStorage.setItem(`xhs_list_scroll_v1:${key}`, JSON.stringify(payload));
            } catch {}
        },
        loadListScrollState() {
            try {
                const key = this.getListKey();
                const raw = sessionStorage.getItem(`xhs_list_scroll_v1:${key}`);
                if (!raw) return null;
                const obj = JSON.parse(raw);
                if (!obj || typeof obj !== 'object') return null;
                if (typeof obj.ts !== 'number' || (Date.now() - obj.ts) > 30 * 60 * 1000) return null; // 30min
                return obj;
            } catch {
                return null;
            }
        },
        isDarkMode() {
            const c = Config.get();
            if (c.darkMode === 'dark') return true;
            if (c.darkMode === 'light') return false;
            return window.matchMedia?.('(prefers-color-scheme: dark)').matches;
        },
        escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        },
        navigateTo(pathOrUrl) {
            const url = pathOrUrl?.toString?.() || '';
            if (!url) return;
            try {
                if (window.DiscourseURL?.routeTo && typeof window.DiscourseURL.routeTo === 'function') {
                    const u = new URL(url, window.location.origin);
                    if (u.origin === window.location.origin) {
                        window.DiscourseURL.routeTo(u.pathname + u.search + u.hash);
                        return;
                    }
                }
            } catch {}
            window.location.href = url;
        },
        extractTopicIdFromUrl(url) {
            const u = url?.toString?.() || '';
            if (!u) return '';
            const m = /\/t\/topic\/(\d+)/u.exec(u) || /\/t\/(\d+)/u.exec(u);
            return m ? String(m[1]) : '';
        },
        getTopicRows() {
            try {
                const tableRows = document.querySelectorAll('.topic-list tbody tr[data-topic-id]');
                if (tableRows && tableRows.length) return Array.from(tableRows);
            } catch {}
            try {
                const items = document.querySelectorAll('.topic-list .topic-list-item[data-topic-id], .topic-list-item[data-topic-id]');
                if (items && items.length) return Array.from(items);
            } catch {}
            return [];
        },
        /**
         * 从 /c/... 链接中解析 top-level 分类 slug（用于映射 emoji）。
         * 例：
         * - /c/shuiyuan-portal/soul-harbour/69 -> shuiyuan-portal
         * - /c/shuiyuan-events/65 -> shuiyuan-events
         */
        parsePrimaryCategorySlug(categoryHref) {
            if (!categoryHref) return null;
            try {
                const url = new URL(categoryHref, window.location.origin);
                const path = url.pathname;
                if (!path.startsWith('/c/')) return null;
                const parts = path.replace(/^\/c\//u, '').split('/').filter(Boolean);
                if (parts.length === 0) return null;
                // /c/<slug>/<id> 或 /c/<parent>/<child>/<id>
                return parts[0];
            } catch {
                return null;
            }
        },
        getPrimaryCategoryEmoji(categoryHref, categoryName) {
            const slug = this.parsePrimaryCategorySlug(categoryHref);
            const bySlug = {
                // 常见 top-level slug -> emoji（允许不全，未知则不显示）
                'shuiyuan-portal': '📰',   // 水源广场
                'campus-life': '🏫',       // 校园生活
                'life-experience': '🧭',   // 人生经验
                'sjtu-study': '📚',        // 学在交大
                'culture-arts': '🎨',      // 文化艺术
                'leisure-entertainment': '🎮', // 休闲娱乐
                'technology': '💻',        // 数码科技
                'ads': '📢',               // 广而告之
                'clubs': '🤝',             // 社团组织（待确认 slug）
                'site-affairs': '🛠️',      // 水源站务（待确认 slug）
                'shuiyuan-events': '🎁',   // 水源活动
            };
            if (slug && bySlug[slug]) return bySlug[slug];
            const byName = {
                '水源广场': '📰',
                '校园生活': '🏫',
                '人生经验': '🧭',
                '学在交大': '📚',
                '文化艺术': '🎨',
                '休闲娱乐': '🎮',
                '数码科技': '💻',
                '广而告之': '📢',
                '社团组织': '🤝',
                '水源站务': '🛠️',
                '水源活动': '🎁',
            };
            if (categoryName && byName[categoryName]) return byName[categoryName];
            return '';
        },
        isListPage() {
            if (!this.isListLikePath()) return false;
            // 兜底：必须确实存在 topic-list（避免影响消息/个人页等）
            return this.getTopicRows().length > 0;
        },
        isListLikePath() {
            const path = window.location.pathname;
            return path === '/' ||
                path.startsWith('/latest') ||
                path.startsWith('/top') ||
                path.startsWith('/categories') ||
                path.startsWith('/tag/') ||
                path.startsWith('/c/');
        },
        seededRandom(seed) {
            // 简单的字符串哈希转随机数
            let h = 0;
            const str = String(seed);
            for(let i=0; i<str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
            return () => {
                h = Math.imul(h ^ h >>> 15, h | 1);
                h ^= h + Math.imul(h ^ h >>> 7, h | 61);
                return ((h ^ h >>> 14) >>> 0) / 4294967296;
            };
        }
    };

    /* ============================================
     * 3. 样式注入
     * ============================================ */
    const Styles = {
        baseId: 'xhs-base',
        themeId: 'xhs-theme',

        injectBase() {
            if (document.getElementById(this.baseId)) return;
            const css = `
                /* 悬浮按钮 */
                .xhs-float-btn {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    width: 48px;
                    height: 48px;
                    background: #fff;
                    border-radius: 50%;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                    cursor: pointer;
                    z-index: 99999;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: transform 0.2s;
                    border: 2px solid var(--xhs-c, #C8102E);
                }
                .xhs-float-btn:hover { transform: scale(1.1); }
                .xhs-float-btn img { width: 28px; height: 28px; object-fit: contain; }
                .xhs-float-btn .xhs-float-btn-fallback {
                    width: 28px;
                    height: 28px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 20px;
                    color: var(--xhs-c, #C8102E);
                }

                /* 设置面板 */
                .xhs-panel-overlay {
                    position: fixed; inset: 0; background: rgba(0,0,0,0.4); 
                    z-index: 99998; display: none; opacity: 0; transition: opacity 0.3s;
                }
                .xhs-panel-overlay.show { display: block; opacity: 1; }
                
                .xhs-panel {
                    position: fixed; top: 50%; left: 50%; 
                    transform: translate(-50%, -50%) scale(0.9);
                    width: 320px; background: #fff; border-radius: 16px;
                    z-index: 99999; opacity: 0; visibility: hidden;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                    transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
                    overflow: hidden;
                }
                .xhs-panel.show { opacity: 1; visibility: visible; transform: translate(-50%, -50%) scale(1); }
                
                .xhs-panel-header {
                    padding: 16px 20px; background: var(--xhs-c); color: #fff;
                    display: flex; justify-content: space-between; align-items: center;
                    font-weight: 600;
                }
                .xhs-panel-close { cursor: pointer; font-size: 20px; opacity: 0.8; }
                .xhs-panel-close:hover { opacity: 1; }
                
                .xhs-panel-body { padding: 20px; max-height: 70vh; overflow-y: auto; }
                
                .xhs-row { 
                    display: flex; justify-content: space-between; align-items: center;
                    margin-bottom: 16px; font-size: 14px; color: #333;
                }
                .xhs-row .xhs-input {
                    width: 88px;
                    padding: 6px 8px;
                    border-radius: 10px;
                    border: 1px solid rgba(0,0,0,0.12);
                    background: rgba(255,255,255,0.95);
                    color: #333;
                }
                body.xhs-dark .xhs-row .xhs-input {
                    border: 1px solid rgba(255,255,255,0.16);
                    background: rgba(0,0,0,0.25);
                    color: rgba(255,255,255,0.9);
                }
                .xhs-desc { font-size: 12px; color: #999; margin-top: 2px; }
                
                .xhs-switch {
                    width: 40px; height: 22px; background: #ddd; border-radius: 11px;
                    position: relative; cursor: pointer; transition: background 0.2s;
                }
                .xhs-switch.on { background: var(--xhs-c); }
                .xhs-switch::after {
                    content:''; position: absolute; top: 2px; left: 2px;
                    width: 18px; height: 18px; background: #fff; border-radius: 50%;
                    transition: transform 0.2s;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                }
                .xhs-switch.on::after { transform: translateX(18px); }
                
                .xhs-colors { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin-top: 8px; }
                .xhs-color-item {
                    width: 100%; padding-bottom: 100%; border-radius: 50%;
                    cursor: pointer; border: 2px solid transparent; position: relative;
                }
                .xhs-color-item.active { border-color: #333; transform: scale(1.1); }
                
                /* 移动端适配面板 */
                @media(max-width: 600px) {
                    .xhs-panel { width: 90%; top: auto; bottom: 20px; left: 50%; transform: translate(-50%, 20px); }
                    .xhs-panel.show { transform: translate(-50%, 0); }
                }
            `;
            GM_addStyle(css);
        },

        injectTheme() {
            this.removeTheme();
            const cfg = Config.get();
            if (!cfg.enabled) return;

            const c = cfg.themeColor;
            const rgb = Utils.hexToRgb(c);
            const isDark = Utils.isDarkMode();
            const colsDesktop = cfg.columnCount;
            const cols1400 = Math.min(colsDesktop, 4);
            const cols1100 = Math.min(colsDesktop, 3);
            const cols800 = Math.min(colsDesktop, 2);
            
            document.body.classList.toggle('xhs-dark', isDark);

            const css = `
                :root {
                    --xhs-c: ${c};
                    --xhs-rgb: ${rgb};
                    --xhs-bg: ${isDark ? '#1a1a1a' : '#f4f6f8'};
                    --xhs-card-bg: ${isDark ? '#2d2d2d' : '#fff'};
                    --xhs-text: ${isDark ? '#eee' : '#333'};
                    --xhs-text-sub: ${isDark ? '#aaa' : '#666'};
                    --xhs-cols: ${colsDesktop};
                }

                body.xhs-on { background: var(--xhs-bg) !important; }
                
                /* 隐藏原生列表 */
                body.xhs-on .topic-list, body.xhs-on .topic-list-header { display: none !important; }
                
                /* 瀑布流容器 */
                .xhs-grid {
                    /* v4.12：不再使用 CSS columns（会在无限下拉/图片异步加载时触发重排，造成闪烁与“整体重新分列”） */
                    display: flex;
                    align-items: flex-start;
                    gap: 16px;
                    padding: 16px 0;
                    max-width: 1400px;
                    margin: 0 auto;
                }
                .xhs-grid .xhs-col {
                    flex: 1 1 0;
                    min-width: 0;
                    display: flex;
                    flex-direction: column;
                    gap: 16px;
                }
                .xhs-grid.grid-mode { display: grid; grid-template-columns: repeat(var(--xhs-cols), 1fr); gap: 16px; }
                
                @media(max-width: 1400px) { .xhs-grid.grid-mode { grid-template-columns: repeat(${cols1400}, 1fr); } }
                @media(max-width: 1100px) { .xhs-grid.grid-mode { grid-template-columns: repeat(${cols1100}, 1fr); } }
                @media(max-width: 800px) { .xhs-grid { gap: 10px; } .xhs-grid .xhs-col { gap: 10px; } .xhs-grid.grid-mode { grid-template-columns: repeat(${cols800}, 1fr); gap: 10px; } }

                /* 卡片样式 */
                .xhs-card {
                    break-inside: avoid; background: var(--xhs-card-bg);
                    border-radius: 12px; margin-bottom: 0;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.04);
                    overflow: hidden; position: relative;
                    transition: transform 0.2s, box-shadow 0.2s;
                    display: flex; flex-direction: column;
                }
                .xhs-card:hover { transform: translateY(-4px); box-shadow: 0 8px 20px rgba(0,0,0,0.1); z-index: 2; }
                .xhs-card.xhs-refresh-highlight {
                    box-shadow: 0 0 0 3px rgba(var(--xhs-rgb), 0.30), 0 14px 34px rgba(0,0,0,0.12) !important;
                }
                .xhs-card.xhs-refresh-highlight::before {
                    content: '已更新';
                    position: absolute;
                    top: 10px;
                    left: 10px;
                    z-index: 3;
                    font-size: 11px;
                    font-weight: 700;
                    padding: 3px 8px;
                    border-radius: 999px;
                    color: ${isDark ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.78)'};
                    background: ${isDark ? 'rgba(0,0,0,0.30)' : 'rgba(255,255,255,0.65)'};
                    border: 1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)'};
                    backdrop-filter: blur(8px);
                }
                .xhs-card.xhs-restore-highlight {
                    box-shadow: 0 0 0 3px rgba(var(--xhs-rgb), 0.28), 0 14px 34px rgba(0,0,0,0.12) !important;
                }
                
                /* 封面区域 */
                .xhs-cover {
                    width: 100%; position: relative;
                    background: ${isDark ? '#333' : '#eee'};
                    min-height: 120px; /* 最小高度 */
                }
                .xhs-real-img {
                    width: 100%; height: auto; display: block; object-fit: cover;
                    opacity: 0; transition: opacity 0.3s;
                }
                .xhs-real-img.loaded { opacity: 1; }
                
                /* 文字封面样式（更丰富，参考 littleLBook 的配色/装饰思路） */
                .xhs-text-cover {
                    padding: 26px 18px;
                    text-align: left;
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    min-height: 168px;
                    position: relative;
                    overflow: hidden;
                    background:
                        linear-gradient(180deg, ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.60)'} 0%, rgba(0,0,0,0) 62%),
                        var(--xhs-cover-bg, ${isDark ? '#2c2c2c' : '#fff'});
                    color: var(--xhs-cover-fg, var(--xhs-text));
                    text-shadow: ${isDark ? '0 1px 0 rgba(0,0,0,0.25)' : 'none'};
                    border: 1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'};
                    box-shadow: inset 0 1px 0 ${isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.65)'};
                }
                .xhs-text-cover::before {
                    content: '';
                    position: absolute;
                    inset: -40px;
                    pointer-events: none;
                    opacity: ${isDark ? '0.30' : '0.22'};
                    filter: blur(0.2px);
                    background-image:
                        radial-gradient(240px 140px at 14% 18%, var(--xhs-cover-glow1, rgba(var(--xhs-rgb), 0.50)), rgba(0,0,0,0) 70%),
                        radial-gradient(260px 160px at 86% 22%, var(--xhs-cover-glow2, rgba(255,255,255,0.55)), rgba(0,0,0,0) 72%),
                        radial-gradient(260px 180px at 70% 90%, var(--xhs-cover-glow3, rgba(0,0,0,0.18)), rgba(0,0,0,0) 70%);
                }
                .xhs-text-cover::after {
                    content: '';
                    position: absolute;
                    inset: 0;
                    pointer-events: none;
                    opacity: ${isDark ? '0.10' : '0.08'};
                    background-image:
                        radial-gradient(circle at 1px 1px, rgba(255,255,255,0.22) 0 1px, rgba(0,0,0,0) 1px 10px),
                        repeating-linear-gradient(135deg, rgba(255,255,255,0.28) 0 1px, rgba(255,255,255,0.0) 1px 10px);
                    mix-blend-mode: overlay;
                }
                .xhs-bg {
                    position: absolute;
                    inset: 0;
                    pointer-events: none;
                    z-index: 0;
                    opacity: ${isDark ? '0.22' : '0.18'};
                    mix-blend-mode: overlay;
                }
                .xhs-bg.secondary { opacity: ${isDark ? '0.14' : '0.10'}; filter: blur(0.2px); }
                .xhs-bg.pat-grid {
                    background-image:
                        repeating-linear-gradient(0deg, rgba(255,255,255,0.18) 0 1px, rgba(0,0,0,0) 1px 14px),
                        repeating-linear-gradient(90deg, rgba(255,255,255,0.12) 0 1px, rgba(0,0,0,0) 1px 16px);
                }
                .xhs-bg.pat-dots {
                    background-image: radial-gradient(circle at 1px 1px, rgba(255,255,255,0.28) 0 1px, rgba(0,0,0,0) 1px 12px);
                    background-size: 12px 12px;
                }
                .xhs-bg.pat-wave {
                    background-image:
                        repeating-linear-gradient(135deg, rgba(255,255,255,0.22) 0 2px, rgba(0,0,0,0) 2px 14px),
                        repeating-linear-gradient(45deg, rgba(0,0,0,0.10) 0 1px, rgba(0,0,0,0) 1px 18px);
                }
                .xhs-bg.pat-rings {
                    background-image: repeating-radial-gradient(circle at 20% 30%, rgba(255,255,255,0.18) 0 1px, rgba(0,0,0,0) 1px 14px);
                }
                .xhs-bg.pat-topo {
                    background-image:
                        repeating-radial-gradient(circle at 80% 20%, rgba(255,255,255,0.18) 0 1px, rgba(0,0,0,0) 1px 12px),
                        repeating-radial-gradient(circle at 20% 80%, rgba(0,0,0,0.12) 0 1px, rgba(0,0,0,0) 1px 16px);
                }
                .xhs-card:hover .xhs-text-cover::before {
                    opacity: ${isDark ? '0.38' : '0.28'};
                }
                .xhs-card:hover .xhs-text-cover::after {
                    opacity: ${isDark ? '0.14' : '0.10'};
                }
                .xhs-deco {
                    position: absolute;
                    pointer-events: none;
                    line-height: 1;
                    color: var(--xhs-deco, rgba(0,0,0,0.16));
                    opacity: ${isDark ? '0.55' : '0.35'};
                    z-index: 0;
                }
                .xhs-deco.corner { font-size: 16px; }
                .xhs-deco.tl { top: 12px; left: 12px; }
                .xhs-deco.tr { top: 12px; right: 12px; }
                .xhs-deco.bl { bottom: 12px; left: 12px; }
                .xhs-deco.br { bottom: 12px; right: 12px; }
                .xhs-deco.line { font-size: 9px; letter-spacing: 4px; opacity: ${isDark ? '0.35' : '0.25'}; }
                .xhs-deco.line-t { top: 10px; left: 50%; transform: translateX(-50%); }
                .xhs-deco.line-b { bottom: 10px; left: 50%; transform: translateX(-50%); }
                .xhs-deco.band {
                    height: 30px;
                    width: 160%;
                    left: -30%;
                    top: 18px;
                    transform: rotate(-8deg);
                    opacity: ${isDark ? '0.20' : '0.16'};
                    background: linear-gradient(90deg, rgba(255,255,255,0.0) 0%, rgba(255,255,255,0.40) 40%, rgba(255,255,255,0.0) 100%);
                    filter: blur(0.1px);
                }
                .xhs-deco.band.b2 { top: auto; bottom: 22px; transform: rotate(10deg); opacity: ${isDark ? '0.16' : '0.12'}; }
                .xhs-deco.tape {
                    width: 96px;
                    height: 22px;
                    right: 16px;
                    top: 16px;
                    transform: rotate(8deg);
                    opacity: ${isDark ? '0.22' : '0.18'};
                    background: linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0.18));
                    border: 1px solid rgba(255,255,255,0.35);
                    box-shadow: 0 6px 14px rgba(0,0,0,0.10);
                    border-radius: 6px;
                    mix-blend-mode: overlay;
                }
                .xhs-deco.tape.t2 { left: 14px; right: auto; top: auto; bottom: 18px; transform: rotate(-10deg); width: 86px; }
                .xhs-deco.big {
                    font-size: 124px;
                    opacity: ${isDark ? '0.30' : '0.20'};
                    left: 50%;
                    top: 58%;
                    transform: translate(-50%, -50%) rotate(-12deg);
                    filter: none;
                    mix-blend-mode: ${isDark ? 'screen' : 'multiply'};
                }
                .xhs-deco.big.p2 { left: 68%; top: 42%; transform: translate(-50%, -50%) rotate(10deg); }
                .xhs-deco.big.p3 { left: 36%; top: 72%; transform: translate(-50%, -50%) rotate(-18deg); }
                .xhs-deco.big.p4 { left: 62%; top: 36%; transform: translate(-50%, -50%) rotate(-2deg); }
                .xhs-deco.quote {
                    font-size: 44px;
                    opacity: ${isDark ? '0.20' : '0.14'};
                    filter: blur(0.1px);
                }
                .xhs-deco.quote.tl { top: 8px; left: 10px; }
                .xhs-deco.quote.br { bottom: 8px; right: 12px; }

                .xhs-emoji-icon { position: relative; z-index: 1; font-size: 44px; margin-bottom: 12px; }
                .xhs-text-excerpt { 
                    position: relative;
                    z-index: 1;
                    font-size: 16px;
                    line-height: 1.65;
                    font-weight: 600;
                    color: inherit;
                    overflow: hidden;
                    display: -webkit-box;
                    -webkit-line-clamp: 6;
                    -webkit-box-orient: vertical;
                }
                .xhs-text-excerpt.dropcap::first-letter {
                    font-size: 30px;
                    line-height: 1;
                    font-weight: 800;
                    float: left;
                    padding-right: 6px;
                    margin-top: 2px;
                    opacity: ${isDark ? '0.95' : '0.90'};
                }
                .xhs-sticker {
                    position: absolute;
                    right: 14px;
                    bottom: 16px;
                    z-index: 2;
                    pointer-events: none;
                    padding: 4px 10px;
                    border-radius: 999px;
                    font-size: 12px;
                    font-weight: 700;
                    letter-spacing: 0.5px;
                    color: inherit;
                    background: ${isDark ? 'rgba(0,0,0,0.28)' : 'rgba(255,255,255,0.55)'};
                    border: 1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)'};
                    box-shadow: 0 10px 22px rgba(0,0,0,0.10);
                    backdrop-filter: blur(6px);
                    transform: rotate(6deg);
                }
                
                /* 关键词高亮：每套文字封面可通过 --hl-color 自定义 */
                .xhs-hl { 
                    background: linear-gradient(
                        180deg,
                        rgba(0,0,0,0) 60%,
                        var(--hl-color, rgba(var(--xhs-rgb), 0.22)) 60%
                    );
                    font-weight: 700;
                    margin: 0 2px;
                    padding: 0 2px;
                    border-radius: 4px;
                }
                .xhs-ul {
                    text-decoration: underline;
                    text-decoration-thickness: 2px;
                    text-underline-offset: 3px;
                    text-decoration-color: var(--hl-color, rgba(var(--xhs-rgb), 0.55));
                    font-weight: 700;
                    padding: 0 1px;
                }
                .xhs-wave {
                    text-decoration: underline wavy;
                    text-decoration-thickness: 1.5px;
                    text-underline-offset: 3px;
                    text-decoration-color: var(--hl-color, rgba(var(--xhs-rgb), 0.55));
                    font-weight: 700;
                    padding: 0 1px;
                }
                .xhs-dot {
                    position: relative;
                    font-weight: 700;
                    padding: 0 1px;
                }
                .xhs-dot::after {
                    content: '•';
                    position: absolute;
                    bottom: -8px;
                    left: 50%;
                    transform: translateX(-50%);
                    font-size: 8px;
                    opacity: 0.6;
                    color: var(--hl-color, rgba(var(--xhs-rgb), 0.75));
                }
                .xhs-bd { font-weight: 800; letter-spacing: 0.2px; }

                /* 文字封面配色（10 套） */
                ${isDark ? `
                    .xhs-text-cover.s1 { --xhs-cover-bg: #3D2222; --xhs-cover-fg: #F5C6C6; --hl-color: rgba(252,129,129,0.45); --xhs-deco: rgba(252,129,129,0.35); --xhs-cover-glow1: rgba(252,129,129,0.45); }
                    .xhs-text-cover.s2 { --xhs-cover-bg: #1E3A5F; --xhs-cover-fg: #BEE3F8; --hl-color: rgba(99,179,237,0.45);  --xhs-deco: rgba(99,179,237,0.35);  --xhs-cover-glow1: rgba(99,179,237,0.45); }
                    .xhs-text-cover.s3 { --xhs-cover-bg: #1C3D2D; --xhs-cover-fg: #C6F6D5; --hl-color: rgba(104,211,145,0.45); --xhs-deco: rgba(104,211,145,0.35); --xhs-cover-glow1: rgba(104,211,145,0.45); }
                    .xhs-text-cover.s4 { --xhs-cover-bg: #2D2248; --xhs-cover-fg: #E9D8FD; --hl-color: rgba(183,148,244,0.45); --xhs-deco: rgba(183,148,244,0.35); --xhs-cover-glow1: rgba(183,148,244,0.45); }
                    .xhs-text-cover.s5 { --xhs-cover-bg: #3D3020; --xhs-cover-fg: #FEEBC8; --hl-color: rgba(246,173,85,0.45);  --xhs-deco: rgba(246,173,85,0.35);  --xhs-cover-glow1: rgba(246,173,85,0.45); }
                    .xhs-text-cover.s6 { --xhs-cover-bg: #1A3D3D; --xhs-cover-fg: #B2F5EA; --hl-color: rgba(79,209,197,0.45);  --xhs-deco: rgba(79,209,197,0.35);  --xhs-cover-glow1: rgba(79,209,197,0.45); }
                    .xhs-text-cover.s7 { --xhs-cover-bg: #3D3D1A; --xhs-cover-fg: #FAF089; --hl-color: rgba(236,201,75,0.45);  --xhs-deco: rgba(236,201,75,0.35);  --xhs-cover-glow1: rgba(236,201,75,0.45); }
                    .xhs-text-cover.s8 { --xhs-cover-bg: #3D1A2D; --xhs-cover-fg: #FED7E2; --hl-color: rgba(246,135,179,0.45); --xhs-deco: rgba(246,135,179,0.35); --xhs-cover-glow1: rgba(246,135,179,0.45); }
                    .xhs-text-cover.s9 { --xhs-cover-bg: #1A3A3D; --xhs-cover-fg: #C4F1F9; --hl-color: rgba(118,228,247,0.45); --xhs-deco: rgba(118,228,247,0.35); --xhs-cover-glow1: rgba(118,228,247,0.45); }
                    .xhs-text-cover.s10{ --xhs-cover-bg: #3D2A1A; --xhs-cover-fg: #FFE4CA; --hl-color: rgba(255,159,90,0.45);  --xhs-deco: rgba(255,159,90,0.35);  --xhs-cover-glow1: rgba(255,159,90,0.45); }
                ` : `
                    .xhs-text-cover.s1 { --xhs-cover-bg: #FFF5F5; --xhs-cover-fg: #4A2C2C; --hl-color: rgba(254,178,178,0.70); --xhs-deco: rgba(252,129,129,0.35); --xhs-cover-glow1: rgba(252,129,129,0.40); }
                    .xhs-text-cover.s2 { --xhs-cover-bg: #EBF8FF; --xhs-cover-fg: #2A4365; --hl-color: rgba(144,205,244,0.70); --xhs-deco: rgba(99,179,237,0.30);  --xhs-cover-glow1: rgba(99,179,237,0.35); }
                    .xhs-text-cover.s3 { --xhs-cover-bg: #F0FFF4; --xhs-cover-fg: #22543D; --hl-color: rgba(154,230,180,0.70); --xhs-deco: rgba(104,211,145,0.30); --xhs-cover-glow1: rgba(104,211,145,0.35); }
                    .xhs-text-cover.s4 { --xhs-cover-bg: #FAF5FF; --xhs-cover-fg: #44337A; --hl-color: rgba(214,188,250,0.75); --xhs-deco: rgba(183,148,244,0.30); --xhs-cover-glow1: rgba(183,148,244,0.35); }
                    .xhs-text-cover.s5 { --xhs-cover-bg: #FFFAF0; --xhs-cover-fg: #744210; --hl-color: rgba(251,211,141,0.75); --xhs-deco: rgba(246,173,85,0.30);  --xhs-cover-glow1: rgba(246,173,85,0.35); }
                    .xhs-text-cover.s6 { --xhs-cover-bg: #E6FFFA; --xhs-cover-fg: #234E52; --hl-color: rgba(129,230,217,0.75); --xhs-deco: rgba(79,209,197,0.28);  --xhs-cover-glow1: rgba(79,209,197,0.32); }
                    .xhs-text-cover.s7 { --xhs-cover-bg: #FFFFF0; --xhs-cover-fg: #5F370E; --hl-color: rgba(246,224,94,0.75);  --xhs-deco: rgba(236,201,75,0.28);  --xhs-cover-glow1: rgba(236,201,75,0.32); }
                    .xhs-text-cover.s8 { --xhs-cover-bg: #FFF5F7; --xhs-cover-fg: #521B41; --hl-color: rgba(251,182,206,0.75); --xhs-deco: rgba(246,135,179,0.28); --xhs-cover-glow1: rgba(246,135,179,0.32); }
                    .xhs-text-cover.s9 { --xhs-cover-bg: #EDFDFD; --xhs-cover-fg: #1D4044; --hl-color: rgba(157,236,249,0.75); --xhs-deco: rgba(118,228,247,0.25); --xhs-cover-glow1: rgba(118,228,247,0.30); }
                    .xhs-text-cover.s10{ --xhs-cover-bg: #FFF8F1; --xhs-cover-fg: #63351D; --hl-color: rgba(255,189,138,0.75); --xhs-deco: rgba(255,159,90,0.25);  --xhs-cover-glow1: rgba(255,159,90,0.30); }
                `}
                
                /* 卡片信息区 */
                .xhs-info { padding: 12px; }
                .xhs-title {
                    font-size: 14px; font-weight: 600; color: var(--xhs-text);
                    margin-bottom: 8px; line-height: 1.4;
                    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
                    text-decoration: none;
                }
                .xhs-title:hover { color: var(--xhs-c); }
                
                .xhs-meta { display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--xhs-text-sub); }
                .xhs-user { display: flex; align-items: center; gap: 6px; color: inherit; text-decoration: none; }
                .xhs-user:hover { color: var(--xhs-c); }
                .xhs-avatar { width: 20px; height: 20px; border-radius: 50%; background: #ddd; object-fit: cover;}
                
                .xhs-stats { display: flex; gap: 8px; }
                .xhs-stat-item { display: flex; align-items: center; gap: 2px; }

                /* 标签与置顶 */
                .xhs-tag {
                    position: absolute; top: 8px; left: 8px;
                    background: rgba(255,255,255,0.9); backdrop-filter: blur(4px);
                    color: var(--xhs-c); font-size: 10px; padding: 2px 6px; border-radius: 4px;
                    font-weight: 600; box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                }
                .xhs-pin {
                    position: absolute; top: 8px; right: 8px;
                    background: var(--xhs-c); color: #fff;
                    font-size: 10px; padding: 2px 6px; border-radius: 4px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                }

                /* 话题 tags（多标签） */
                .xhs-category-bar {
                    position: absolute;
                    top: 8px;
                    left: 8px;
                    right: 8px;
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                    align-items: center;
                    pointer-events: auto;
                }
                .xhs-cat-pill {
                    pointer-events: auto;
                    background: rgba(255,255,255,0.9);
                    backdrop-filter: blur(4px);
                    color: var(--xhs-c);
                    font-size: 10px;
                    padding: 2px 6px;
                    border-radius: 999px;
                    font-weight: 700;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                }
                .xhs-tag-pill {
                    pointer-events: auto;
                    background: rgba(0,0,0,0.08);
                    color: var(--xhs-text-sub);
                    font-size: 10px;
                    padding: 2px 6px;
                    border-radius: 999px;
                    cursor: pointer;
                }
                body.xhs-dark .xhs-cat-pill {
                    background: rgba(0,0,0,0.55);
                    color: #fff;
                }
                body.xhs-dark .xhs-tag-pill {
                    background: rgba(255,255,255,0.10);
                    color: rgba(255,255,255,0.78);
                }

                /* 外链标识（topic-featured-link） */
                .xhs-link-badge {
                    position: absolute;
                    right: 8px;
                    bottom: 8px;
                    background: rgba(0,0,0,0.55);
                    color: #fff;
                    font-size: 10px;
                    padding: 2px 6px;
                    border-radius: 999px;
                    backdrop-filter: blur(4px);
                    box-shadow: 0 2px 4px rgba(0,0,0,0.18);
                    max-width: calc(100% - 16px);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                /* 有图封面：加轻微渐变提升可读性 */
                .xhs-cover.has-img { background: transparent; }
                .xhs-cover.has-img::after {
                    content: '';
                    position: absolute;
                    inset: 0;
                    pointer-events: none;
                    background: linear-gradient(180deg, rgba(0,0,0,0.00) 52%, rgba(0,0,0,0.22) 100%);
                }

                /* 卡片更“立体”一点 */
                .xhs-card {
                    border-radius: 14px;
                    box-shadow: 0 6px 22px rgba(0,0,0,0.06);
                }
                .xhs-card:hover {
                    box-shadow: 0 10px 28px rgba(0,0,0,0.10);
                }

                /* 统计信息开关（避免重建 DOM） */
                body[data-xhs-show-stats="0"] .xhs-replies { display: none !important; }
                
                /* 暗色模式特定调整 */
                ${isDark ? `
                    .xhs-tag { background: rgba(0,0,0,0.7); color: #fff; }
                    .xhs-text-cover.s1 { background: #2c1e1e; }
                    .xhs-text-cover.s2 { background: #1e2c3a; }
                    .xhs-text-cover.s3 { background: #1e2c22; }
                    .xhs-text-cover.s4 { background: #2c1e2c; }
                ` : `
                    .xhs-text-cover.s1 { background: #fff5f5; }
                    .xhs-text-cover.s2 { background: #f0faff; }
                    .xhs-text-cover.s3 { background: #f6ffed; }
                    .xhs-text-cover.s4 { background: #fff0f6; }
                `}
            `;
            
            const style = document.createElement('style');
            style.id = this.themeId;
            style.textContent = css;
            document.head.appendChild(style);
        },
        
        removeTheme() { document.getElementById(this.themeId)?.remove(); }
    };

    /* ============================================
     * 4. 瀑布流核心逻辑
     * ============================================ */
    const Grid = {
        container: null,
        observer: null,
        queue: [],
        cache: new Map(),
        processing: false,
        renderScheduleTimer: null,
        
        // 速率限制配置
        rateLimit: {
            lastReq: 0,
            interval: 300, // 最小间隔 300ms
            cooldown: 0    // 冷却时间
        },

        persistentCache: null,
        persistFlushTimer: null,
        persistDirty: false,

        listMetaUrl: null,
        listMetaPromise: null,
        listTopicMeta: new Map(),
        listOrderTop: [],
        lastFirstTid: '',
        cornerDecos: ['✦', '✶', '✷', '✧', '✺', '✹', '✸', '❖', '❂', '✣', '✤', '✪', '✫'],
        lineChars: ['·', '•', '∙', '⋯', '─', '═', '—', '~', '≈', '✦', '✶', '✷'],
        bgPatterns: ['pat-grid', 'pat-dots', 'pat-wave', 'pat-rings', 'pat-topo'],
        columns: [],
        currentColumnCount: 0,

        getListJsonUrl() {
            const path = window.location.pathname;
            const search = window.location.search || '';

            if (path === '/') return `/latest.json${search}`;
            if (path.startsWith('/latest')) return `/latest.json${search}`;
            if (path.startsWith('/top')) return `${path}.json${search}`;
            if (path.startsWith('/categories')) return `/categories.json${search}`;
            if (path.startsWith('/tag/')) return `${path}.json${search}`;
            if (path.startsWith('/c/')) return `${path}.json${search}`;
            return null;
        },

        ensureListMetaLoaded() {
            const url = this.getListJsonUrl();
            if (!url) return;
            if (this.listMetaUrl === url && this.listMetaPromise) return;

            this.listMetaUrl = url;
            this.listTopicMeta = new Map();
            this.listMetaPromise = (async () => {
                try {
                    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
                    if (!res.ok) return;
                    const json = await res.json();
                    const topics = json?.topic_list?.topics;
                    if (!Array.isArray(topics)) return;
                    for (const t of topics) {
                        if (!t || typeof t !== 'object') continue;
                        const tid = String(t.id);
                        if (!tid) continue;
                        const img = t.image_url || t.thumbnail_url || null;
                        const likes = typeof t.like_count === 'number' ? t.like_count : 0;
                        const tags = Array.isArray(t.tags) ? t.tags : [];
                        const featuredLink = t.featured_link || '';
                        this.listTopicMeta.set(tid, { img, likes, tags, featuredLink });
                    }

                    // 列表元信息加载完成后，尽可能填充现有卡片（减少 per-topic 请求）。
                    if (this.container) {
                        for (const card of this.container.querySelectorAll('.xhs-card[data-tid]')) {
                            const tid = card.getAttribute('data-tid');
                            const meta = this.listTopicMeta.get(String(tid));
                            if (!meta) continue;
                            this.applyMetaToCard(card, meta, { fromList: true });
                        }
                    }
                } catch {}
            })();
        },

        scheduleRender() {
            clearTimeout(this.renderScheduleTimer);
            this.renderScheduleTimer = setTimeout(() => {
                try {
                    if (Utils.isListPage()) this.render();
                } catch {}
            }, 80);
        },

        getDesiredColumnCount() {
            const cfg = Config.get();
            const colsDesktop = cfg.columnCount;
            const cols1400 = Math.min(colsDesktop, 4);
            const cols1100 = Math.min(colsDesktop, 3);
            const cols800 = Math.min(colsDesktop, 2);
            const w = window.innerWidth || 1200;
            if (w <= 800) return cols800;
            if (w <= 1100) return cols1100;
            if (w <= 1400) return cols1400;
            return colsDesktop;
        },

        _getDirectColumns() {
            if (!this.container) return [];
            const cols = [];
            for (const el of Array.from(this.container.children || [])) {
                if (el?.classList?.contains('xhs-col')) cols.push(el);
            }
            return cols;
        },

        ensureColumns(force) {
            if (!this.container) return;
            const cfg = Config.get();
            if (!cfg.enabled) return;

            // grid-mode（非错落布局）：直接用 grid，避免任何分列包装
            if (!cfg.cardStagger) {
                this.columns = [];
                this.currentColumnCount = 0;
                const existingCols = this._getDirectColumns();
                if (existingCols.length) {
                    const cards = Array.from(this.container.querySelectorAll('.xhs-card[data-tid]'));
                    this.container.textContent = '';
                    for (const card of cards) this.container.appendChild(card);
                }
                return;
            }

            const desired = this.getDesiredColumnCount();
            const existingCols = this._getDirectColumns();
            if (!force && existingCols.length === desired) {
                this.columns = existingCols;
                this.currentColumnCount = desired;
                return;
            }
            this.rebuildColumns(desired);
        },

        rebuildColumns(desired) {
            if (!this.container) return;
            const cols = Math.max(1, parseInt(desired, 10) || 1);
            const cards = Array.from(this.container.querySelectorAll('.xhs-card[data-tid]'));

            const columns = [];
            for (let i = 0; i < cols; i++) {
                const col = document.createElement('div');
                col.className = 'xhs-col';
                col.dataset.xhsCol = String(i);
                columns.push(col);
            }

            this.container.textContent = '';
            for (const col of columns) this.container.appendChild(col);

            const heights = new Array(columns.length).fill(0);
            const pickColumnIndex = () => {
                let idx = 0;
                let best = heights[0] ?? 0;
                for (let i = 1; i < heights.length; i++) {
                    const h = heights[i] ?? 0;
                    if (h < best) { best = h; idx = i; }
                }
                return idx;
            };

            for (const card of cards) {
                const idx = pickColumnIndex();
                columns[idx].appendChild(card);
                // 读一次 scrollHeight 作为下一次分配参考（不做“回溯重排”，保证稳定）
                heights[idx] = columns[idx].scrollHeight || heights[idx];
            }

            this.columns = columns;
            this.currentColumnCount = columns.length;
        },

        appendCard(card) {
            if (!this.container) return;
            this.ensureColumns(false);
            if (!Config.get().cardStagger) {
                this.container.appendChild(card);
                return;
            }
            const cols = this._getDirectColumns();
            if (!cols.length) {
                this.rebuildColumns(this.getDesiredColumnCount());
            }
            const columns = this._getDirectColumns();
            if (!columns.length) {
                this.container.appendChild(card);
                return;
            }
            let bestIdx = 0;
            let bestH = columns[0].scrollHeight || 0;
            for (let i = 1; i < columns.length; i++) {
                const h = columns[i].scrollHeight || 0;
                if (h < bestH) { bestH = h; bestIdx = i; }
            }
            columns[bestIdx].appendChild(card);
        },

        flashCard(card) {
            if (!card) return;
            card.classList.add('xhs-refresh-highlight');
            setTimeout(() => {
                try { card.classList.remove('xhs-refresh-highlight'); } catch {}
            }, 1800);
        },

        _getPersistentData(tid) {
            const cfg = Config.get();
            if (!cfg.cacheEnabled) return null;
            this.loadPersistentCache();
            const now = Date.now();
            const ttlMs = cfg.cacheTtlMinutes * 60 * 1000;
            const key = String(tid || '');
            if (!key) return null;
            const cached = this.persistentCache.get(key);
            if (!cached || !cached.data) return null;
            const ts = typeof cached.ts === 'number' ? cached.ts : 0;
            if (ttlMs > 0 && ts > 0 && (now - ts) > ttlMs) {
                // 过期则删除，避免反复命中脏数据
                this.persistentCache.delete(key);
                this.persistDirty = true;
                this.schedulePersistFlush();
                return null;
            }
            // 仅在内存里 touch lastAccess（减少 GM_setValue 写入频率）
            cached.lastAccess = now;
            const data = cached.data || {};
            return {
                img: data.img ?? null,
                likes: typeof data.likes === 'number' ? data.likes : (parseInt(data.likes, 10) || 0),
                noImg: Boolean(data.noImg)
            };
        },

        _setPersistentData(tid, data) {
            const cfg = Config.get();
            if (!cfg.cacheEnabled) return;
            this.loadPersistentCache();
            const now = Date.now();
            const key = String(tid || '');
            if (!key) return;
            const next = {
                img: data?.img || null,
                likes: typeof data?.likes === 'number' ? data.likes : (parseInt(data?.likes, 10) || 0),
                noImg: Boolean(data?.noImg)
            };

            const prev = this.persistentCache.get(key);
            const prevData = prev?.data || null;
            const same =
                prevData &&
                prevData.img === next.img &&
                (prevData.likes || 0) === (next.likes || 0) &&
                Boolean(prevData.noImg) === Boolean(next.noImg);
            // 不同才更新时间戳；相同仅 touch lastAccess，减少写入
            const ts = same && typeof prev?.ts === 'number' ? prev.ts : now;
            this.persistentCache.set(key, { ts, lastAccess: now, data: next });
            this.prunePersistentCache();
            this.persistDirty = true;
            this.schedulePersistFlush();
        },

        applyMetaToCard(el, meta, opts) {
            const tid = String(el.dataset.tid || el.getAttribute('data-tid') || '');
            if (!tid) return;
            const existing = this.cache.get(tid) || { img: null, likes: 0, needsImage: true };
            const noImg = Boolean(meta?.noImg);
            const merged = {
                img: meta.img ?? existing.img ?? null,
                likes: (typeof meta.likes === 'number' ? meta.likes : existing.likes) || 0,
                needsImage: noImg ? false : Boolean(existing.needsImage),
                noImg
            };
            if (merged.img) merged.needsImage = false;
            this.cache.set(tid, merged);

            const likeEl = el.querySelector('.xhs-like-count');
            if (likeEl) likeEl.textContent = String(merged.likes ?? 0);

            if (merged.img) {
                const cover = el.querySelector('.xhs-cover');
                if (cover && !cover.querySelector('img.xhs-real-img')) {
                    const img = document.createElement('img');
                    img.src = merged.img;
                    img.className = 'xhs-real-img';
                    img.onload = () => img.classList.add('loaded');
                    cover.querySelector('.xhs-text-cover')?.remove();
                    cover.prepend(img);
                    cover.classList.add('has-img');
                }
            } else if (opts?.fromList) {
                // 列表未提供 image_url，保持需要进一步按需抓取 cooked 的状态
                if (!noImg) this.cache.set(tid, { ...merged, needsImage: true });
            }

            // 列表 JSON 的结果也写入跨页面缓存（避免下次进来还要 per-topic 请求）
            try {
                if (opts?.fromList) this._setPersistentData(tid, { img: merged.img || null, likes: merged.likes || 0, noImg: merged.noImg });
            } catch {}
        },

        loadPersistentCache() {
            if (this.persistentCache) return;
            this.persistentCache = new Map();
            try {
                const raw = GM_getValue('xhs_topic_cache_v1', '{}');
                const obj = JSON.parse(raw || '{}');
                for (const [tid, entry] of Object.entries(obj)) {
                    if (!entry || typeof entry !== 'object') continue;
                    this.persistentCache.set(tid, entry);
                }
                // 载入后做一次过期清理（容量小，扫描成本可控）
                try {
                    const cfg = Config.get();
                    const ttlMs = cfg.cacheTtlMinutes * 60 * 1000;
                    if (cfg.cacheEnabled && ttlMs > 0) {
                        const now = Date.now();
                        for (const [tid, entry] of this.persistentCache.entries()) {
                            const ts = typeof entry?.ts === 'number' ? entry.ts : 0;
                            if (ts && (now - ts) > ttlMs) this.persistentCache.delete(tid);
                        }
                    }
                } catch {}
            } catch {}
        },

        schedulePersistFlush() {
            if (this.persistFlushTimer) return;
            this.persistFlushTimer = setTimeout(() => {
                this.persistFlushTimer = null;
                if (!this.persistDirty) return;
                this.persistDirty = false;
                try {
                    const obj = {};
                    for (const [tid, entry] of this.persistentCache.entries()) {
                        obj[tid] = entry;
                    }
                    GM_setValue('xhs_topic_cache_v1', JSON.stringify(obj));
                } catch {}
            }, 1200);
        },

        prunePersistentCache() {
            const cfg = Config.get();
            if (!cfg.cacheEnabled) return;
            if (!this.persistentCache) return;
            // 先清理过期条目，避免被 LRU 误判
            try {
                const ttlMs = cfg.cacheTtlMinutes * 60 * 1000;
                if (ttlMs > 0) {
                    const now = Date.now();
                    for (const [tid, entry] of this.persistentCache.entries()) {
                        const ts = typeof entry?.ts === 'number' ? entry.ts : 0;
                        if (ts && (now - ts) > ttlMs) this.persistentCache.delete(tid);
                    }
                }
            } catch {}
            const maxEntries = cfg.cacheMaxEntries;
            if (this.persistentCache.size <= maxEntries) return;

            // LRU：按 lastAccess 升序淘汰
            const entries = [...this.persistentCache.entries()];
            entries.sort((a, b) => (a[1]?.lastAccess || 0) - (b[1]?.lastAccess || 0));
            const removeCount = Math.max(0, this.persistentCache.size - maxEntries);
            for (let i = 0; i < removeCount; i++) {
                this.persistentCache.delete(entries[i][0]);
            }
            this.persistDirty = true;
            this.schedulePersistFlush();
        },

        init() {
            this.loadPersistentCache();
            this.ensureListMetaLoaded();
            // 监听页面变化，自动处理新增帖子
            const mo = new MutationObserver((mutations) => {
                let shouldUpdate = false;
                for (let m of mutations) {
                    if (m.addedNodes.length && m.target.classList && !m.target.classList.contains('xhs-grid')) {
                        shouldUpdate = true;
                        break;
                    }
                }
                if (shouldUpdate && Utils.isListPage()) this.scheduleRender();
            });
            mo.observe(document.body, { childList: true, subtree: true });
            
            // 可见性观察器：用于懒加载详情
            this.observer = new IntersectionObserver((entries) => {
                entries.forEach(e => {
                    if (e.isIntersecting) {
                        const tid = e.target.dataset.tid;
                        const cached = tid ? this.cache.get(tid) : null;
                        if (tid && (!cached || cached.needsImage)) {
                            this.queue.push({ el: e.target, tid });
                            this.processQueue();
                        }
                        this.observer.unobserve(e.target);
                    }
                });
            }, { rootMargin: '200px' });

            // 视口变化时，列数可能变化：仅在“错落布局”模式下重建列（不做全局重排，尽量减少抖动）
            window.addEventListener('resize', Utils.debounce(() => {
                try {
                    const cfg = Config.get();
                    if (!cfg.enabled) return;
                    if (!cfg.cardStagger) return;
                    if (!document.body.classList.contains('xhs-on')) return;
                    if (!Utils.isListLikePath()) return;
                    if (!this.container) return;
                    this.ensureColumns(true);
                } catch {}
            }, 180));
        },

        // 处理请求队列 (带退避算法)
        async processQueue() {
            if (this.processing || !this.queue.length) return;
            this.processing = true;

            const now = Date.now();
            if (now < this.rateLimit.cooldown) {
                setTimeout(() => { this.processing = false; this.processQueue(); }, this.rateLimit.cooldown - now);
                return;
            }

            const { el, tid } = this.queue.shift();
            
            try {
                const data = await this.fetchTopic(tid);
                this.updateCard(el, data);
                this.rateLimit.interval = 300; // 成功则重置间隔
            } catch (e) {
                // 失败（如429），增加冷却并放回队列
                if (e.status === 429) {
                    this.rateLimit.cooldown = now + 5000; // 冷却5秒
                    this.queue.unshift({ el, tid }); // 放回队头
                }
                console.warn('[XHS] Fetch error:', e);
            }

            // 间隔处理下一个
            setTimeout(() => {
                this.processing = false;
                this.processQueue();
            }, this.rateLimit.interval);
        },

        async fetchTopic(tid) {
            const cfg = Config.get();
            const now = Date.now();
            const ttlMs = cfg.cacheTtlMinutes * 60 * 1000;
            if (cfg.cacheEnabled) {
                const cachedData = this._getPersistentData(String(tid));
                if (cachedData) return cachedData;
            }

            const res = await fetch(`/t/topic/${tid}.json`, { headers: { 'Accept': 'application/json' } });
            if (!res.ok) throw { status: res.status };
            const json = await res.json();
            
            // 提取图片
            const cooked = json.post_stream?.posts?.[0]?.cooked || '';
            const div = document.createElement('div');
            div.innerHTML = cooked;
            
            const isBadImageSrc = (src) => {
                const s = (src || '').toLowerCase();
                return s.includes('emoji') ||
                    s.includes('avatar') ||
                    s.includes('letter_avatar') ||
                    s.includes('user_avatar') ||
                    s.includes('favicon') ||
                    s.includes('/favicons') ||
                    s.endsWith('.ico');
            };

            const getDim = (img, attr) => {
                const v = img.getAttribute(attr);
                if (!v) return null;
                const n = parseInt(v, 10);
                return Number.isFinite(n) ? n : null;
            };

            // 选择“更像封面图”的图片，避免 onebox/favicon 等小图被误当封面。
            const imgs = Array.from(div.querySelectorAll('img'))
                .map((img) => {
                    const src = img.src || img.getAttribute('src') || '';
                    const width = getDim(img, 'width');
                    const height = getDim(img, 'height');
                    const inOnebox = Boolean(img.closest?.('.onebox'));
                    const className = (img.className || '').toLowerCase();
                    let score = 10;

                    if (!src) score -= 1000;
                    if (img.classList.contains('emoji') || className.includes('emoji')) score -= 1000;
                    if (isBadImageSrc(src)) score -= 1000;
                    if (className.includes('site-icon') || className.includes('favicon')) score -= 1000;

                    if (width !== null && height !== null) {
                        const minSide = Math.min(width, height);
                        if (minSide < 120) score -= 200;
                        if (minSide >= 240) score += 80;
                    }

                    const srcLower = src.toLowerCase();
                    if (srcLower.includes('/secure-uploads/') || srcLower.includes('/uploads/')) score += 60;
                    if (className.includes('thumbnail') || className.includes('onebox')) score += 20;
                    if (inOnebox) score -= 10; // onebox 更可能先出现小图；稍微降权但不一刀切

                    return { src, score };
                })
                .filter((x) => x.score > 0)
                .sort((a, b) => b.score - a.score);
            
            return {
                img: imgs.length > 0 ? imgs[0].src : null,
                likes: json.like_count || 0,
                noImg: imgs.length === 0
            };
        },

        updateCard(el, data) {
            const tid = String(el.dataset.tid);
            const existing = this.cache.get(tid) || { img: null, likes: 0, needsImage: true };
            const noImg = Boolean(data?.noImg);
            const merged = {
                img: data.img ?? existing.img ?? null,
                likes: (typeof data.likes === 'number' ? data.likes : existing.likes) ?? 0,
                needsImage: noImg ? false : !Boolean(data.img),
                noImg
            };
            this.cache.set(tid, merged);

            // 写入跨页面缓存（最小化内容，仅保存必要字段）
            try { this._setPersistentData(tid, { img: merged.img || null, likes: merged.likes || 0, noImg: merged.noImg }); } catch {}
            
            // 更新点赞数
            const likeEl = el.querySelector('.xhs-like-count');
            if (likeEl) likeEl.textContent = String(merged.likes ?? 0);
            this.updateStickerForCard(el, merged.likes ?? 0);

            // 如果有图，替换封面
            if (merged.img) {
                const cover = el.querySelector('.xhs-cover');
                const img = document.createElement('img');
                img.src = merged.img;
                img.className = 'xhs-real-img';
                img.onload = () => img.classList.add('loaded');
                
                // 仅替换文字封面，保留标签/置顶/外链标识等元素
                cover.querySelector('.xhs-text-cover')?.remove();
                cover.querySelector('img.xhs-real-img')?.remove();
                cover.prepend(img);
                
                // 标记为有图模式（可用于调整布局）
                cover.classList.add('has-img');
            }
        },

        render() {
            if (!Config.get().enabled) return;
            const rows = Utils.getTopicRows();
            if (!rows.length) return;

            this.ensureListMetaLoaded();

            if (!this.container) {
                this.container = document.createElement('div');
                this.container.className = `xhs-grid ${Config.get().cardStagger ? '' : 'grid-mode'}`;
                const list = document.querySelector('.topic-list');
                if (list) list.parentNode.insertBefore(this.container, list);
            }
            // v4.12：稳定分列（避免 CSS columns 在无限下拉/图片加载时“整体重排”导致闪烁）
            this.ensureColumns(false);

            // 去重：已渲染过的 tid 不再重复插入卡片（避免 Discourse 反复渲染列表导致重复）
            const existingCards = [...this.container.querySelectorAll('.xhs-card[data-tid]')];
            const existingTidToCards = new Map();
            for (const card of existingCards) {
                const tid = card.getAttribute('data-tid');
                if (!tid) continue;
                if (!existingTidToCards.has(tid)) existingTidToCards.set(tid, []);
                existingTidToCards.get(tid).push(card);
            }
            // 清理同 tid 的重复卡片（保留第一个）
            for (const [tid, cards] of existingTidToCards.entries()) {
                if (cards.length <= 1) continue;
                for (let i = 1; i < cards.length; i++) {
                    cards[i].remove();
                }
            }

            const getTid = (row) => {
                const t = row?.dataset?.topicId ? String(row.dataset.topicId) : '';
                if (t) return t;
                try {
                    const a = row?.querySelector?.('.main-link a.title, a.title');
                    const href = a?.href || a?.getAttribute?.('href') || '';
                    return Utils.extractTopicIdFromUrl(href);
                } catch {
                    return '';
                }
            };

            // “查看 xx 个新的或更新的话题”：列表顺序更新时，给新出现/上升的卡片高光提示
            const tidListAll = rows.map((r) => getTid(r)).filter(Boolean);
            const firstTid = tidListAll[0] || '';
            const isTopRefresh = Boolean(this.lastFirstTid && firstTid && this.lastFirstTid !== firstTid);
            if (firstTid) this.lastFirstTid = firstTid;
            const prevOrder = this.listOrderTop || [];
            const prevIndex = new Map();
            prevOrder.forEach((tid, idx) => prevIndex.set(String(tid), idx));
            const newOrderTop = tidListAll.slice(0, 80);
            this.listOrderTop = newOrderTop;
            const bumpedTids = [];
            if (isTopRefresh && prevOrder.length) {
                newOrderTop.forEach((tid, idx) => {
                    const prev = prevIndex.get(String(tid));
                    if (prev === undefined) bumpedTids.push(String(tid));
                    else if (idx < prev) bumpedTids.push(String(tid));
                });
            }

            rows.forEach(row => {
                const tid = getTid(row);
                if (!tid) return;

                // Discourse SPA 切页/回退可能复用原 DOM：row 仍带 xhs-processed，但对应卡片已被我们移除。
                // 只有在“该 tid 的卡片确实存在”时才跳过。
                const processedTid = row.dataset.xhsProcessedTid;
                const hasCardAlready = existingTidToCards.has(tid);
                if (row.classList.contains('xhs-processed') && processedTid === String(tid) && hasCardAlready) return;
                row.classList.add('xhs-processed');
                row.dataset.xhsProcessedTid = String(tid);
                
                if (hasCardAlready) return;

                const card = this.createCard(row);
                this.appendCard(card);

                // 尽可能用列表接口直接填充点赞/封面，减少 per-topic JSON 请求。
                const listMeta = this.listTopicMeta.get(String(tid));
                if (listMeta) {
                    this.applyMetaToCard(card, listMeta, { fromList: true });
                } else {
                    // 如果列表元信息还没拉到，但跨页面缓存可能有，先用缓存填充
                    const cfg = Config.get();
                    if (cfg.cacheEnabled) {
                        const cachedData = this._getPersistentData(String(tid));
                        if (cachedData) this.applyMetaToCard(card, cachedData, { fromList: true });
                    }
                }
                
                // 加入观察队列
                this.observer.observe(card);
            });

            if (bumpedTids.length) {
                requestAnimationFrame(() => {
                    try {
                        const set = new Set(bumpedTids);
                        this.container?.querySelectorAll?.('.xhs-card[data-tid]')?.forEach((card) => {
                            const tid = String(card.getAttribute('data-tid') || '');
                            if (tid && set.has(tid)) this.flashCard(card);
                        });
                    } catch {}
                });
            }
        },

        createCard(row) {
            const titleLink = row.querySelector('.main-link a.title, a.title');
            const title = titleLink?.textContent?.trim() || '';
            const href = titleLink?.href || titleLink?.getAttribute?.('href') || '';
            const tid = row.dataset.topicId || Utils.extractTopicIdFromUrl(href);
            const category = row.querySelector('.badge-category__name')?.textContent || '';
            const featuredLink = row.querySelector('a.topic-featured-link')?.href || '';
            const categoryHref = row.querySelector('.badge-category__wrapper')?.getAttribute('href') ||
                row.querySelector('.badge-category__wrapper')?.href || '';
            const tagNames = [...new Set([...row.querySelectorAll('.discourse-tags a.discourse-tag')].map((t) => t.textContent.trim()).filter(Boolean))];
            // 兼容桌面/移动端列表结构：移动端头像链接通常是 a[data-user-card]，不一定在 .posters 内
            const userCardAnchor =
                row.querySelector('.posters a[data-user-card]') ||
                row.querySelector('.posters a') ||
                row.querySelector('a[data-user-card]');
            const userCard =
                userCardAnchor?.getAttribute('data-user-card') ||
                userCardAnchor?.dataset?.userCard ||
                '';
            const avatarImg =
                row.querySelector('.posters img.avatar') ||
                userCardAnchor?.querySelector?.('img.avatar') ||
                row.querySelector('img.avatar');
            const avatar = avatarImg?.getAttribute?.('src') || avatarImg?.src || '';
            const user = userCard || (avatarImg?.getAttribute?.('title') || '') || 'SJTUer';
            const userHref = userCard ? `/u/${encodeURIComponent(userCard)}` : '';
            const views = row.querySelector('.views .number')?.textContent || '0';
            const replies = row.querySelector('.posts .number')?.textContent || '0';
            const excerpt = row.querySelector('.topic-excerpt')?.textContent?.trim() || title;
            const pinned = row.classList.contains('pinned');
            let featuredDomain = '';
            if (featuredLink) {
                try {
                    featuredDomain = new URL(featuredLink).hostname;
                } catch {}
            }
            const replyNum = Utils.parseCount(replies);
            const viewNum = Utils.parseCount(views);

            const card = document.createElement('div');
            card.className = 'xhs-card';
            card.dataset.tid = tid;
            card.dataset.replyNum = String(replyNum);
            card.dataset.viewNum = String(viewNum);
            card.dataset.tags = tagNames.join('\n');
            card.dataset.pinned = pinned ? '1' : '0';
            card.dataset.featuredDomain = featuredDomain || '';
            card.dataset.categoryName = category || '';
            card.dataset.userHref = userHref || '';
            card.dataset.userName = userCard || user || '';

            // 1. 生成初始封面（默认文字版，稍后异步加载图片）
            const rand = Utils.seededRandom(tid);
            const styleIdx = Math.floor(rand() * 10) + 1; // 1-10
            
            // 提取 Emoji
            const emojiMatch = title.match(/(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
            const emoji = emojiMatch ? emojiMatch[0] : null;
            
            // 处理摘要文本（关键词高亮）
            const processedExcerpt = this.processText(excerpt, tid);
            const primaryEmoji = Utils.getPrimaryCategoryEmoji(categoryHref, category);
            const categoryLabel = category ? (primaryEmoji ? `${primaryEmoji} ${category}` : category) : '';
            const watermarkEmoji = (primaryEmoji || (emoji ? emoji : '✦')).trim();
            const tagPillsHtml = tagNames.slice(0, 4).map((t) => `<span class="xhs-tag-pill" data-tag-name="${Utils.escapeHtml(t)}" title="跳转到标签：${Utils.escapeHtml(t)}">#${Utils.escapeHtml(t)}</span>`).join('');
            const extraTags = tagNames.length > 4 ? `+${tagNames.length - 4}` : '';
            const decoLayersHtml = this._generateTextCoverLayers(tid, watermarkEmoji);
            const stickerText = this._pickTextCoverSticker(tid, {
                categoryLabel,
                tagNames,
                pinned,
                featuredDomain,
                title,
                excerpt,
                replyNum,
                viewNum,
                likes: (this.listTopicMeta.get(String(tid))?.likes ?? 0),
                categoryName: category
            });
            const coverRand = Utils.seededRandom(tid + '_cover2');
            const useDropcap = coverRand() < 0.42 && !emoji;

            const coverHtml = `
                <div class="xhs-cover">
                    <div class="xhs-text-cover s${styleIdx}">
                        ${decoLayersHtml}
                        ${emoji ? `<div class="xhs-emoji-icon">${emoji}</div>` : ''}
                        <div class="xhs-text-excerpt ${useDropcap ? 'dropcap' : ''}">${processedExcerpt}</div>
                    </div>
                    ${(categoryLabel || tagPillsHtml) ? `
                        <div class="xhs-category-bar">
                            ${categoryLabel ? `<span class="xhs-cat-pill" data-category-href="${Utils.escapeHtml(categoryHref || '')}" title="跳转到分类">${Utils.escapeHtml(categoryLabel)}</span>` : ''}
                            ${tagPillsHtml}
                            ${extraTags ? `<span class="xhs-tag-pill">${Utils.escapeHtml(extraTags)}</span>` : ''}
                        </div>
                    ` : ''}
                    ${pinned ? `<span class="xhs-pin">📌</span>` : ''}
                    ${featuredDomain ? `<span class="xhs-link-badge">🔗 ${Utils.escapeHtml(featuredDomain)}</span>` : ''}
                    ${stickerText ? `<span class="xhs-sticker">${Utils.escapeHtml(stickerText)}</span>` : ''}
                </div>
            `;

            const safeTitle = Utils.escapeHtml(title || '');
            const safeUser = Utils.escapeHtml(user || '');
            const safeUserCard = Utils.escapeHtml(userCard || '');
            const safeUserHref = Utils.escapeHtml(userHref || '');
            const safeAvatar = Utils.escapeHtml(avatar || '');
            const userBlockHtml = (userCard && userHref) ? `
                <a class="xhs-user trigger-user-card" href="${safeUserHref}" data-user-card="${safeUserCard}" data-topic-id="${Utils.escapeHtml(tid)}" data-include-post-count-for="${Utils.escapeHtml(tid)}" aria-label="${safeUserCard}，访问个人资料">
                    <img class="xhs-avatar avatar" src="${safeAvatar}">
                    <span>${safeUser}</span>
                </a>
            ` : `
                <div class="xhs-user">
                    <img class="xhs-avatar" src="${safeAvatar}">
                    <span>${safeUser}</span>
                </div>
            `;
            card.innerHTML = `
                <a class="xhs-card-link" href="${href}" style="text-decoration:none; color:inherit;">
                    ${coverHtml}
                </a>
                <div class="xhs-info">
                    <a class="xhs-title" href="${href}">${safeTitle}</a>
                    <div class="xhs-meta">
                        ${userBlockHtml}
                        <div class="xhs-stats">
                            <span class="xhs-stat-item">❤️ <span class="xhs-like-count">-</span></span>
                            <span class="xhs-replies">💬 ${replies}</span>
                        </div>
                    </div>
                </div>
            `;

            // 处理头像加载失败/空 src（避免 CSP 报错：禁止 inline onerror）
            card.querySelectorAll('img.xhs-avatar').forEach((img) => {
                const src = img.getAttribute('src') || '';
                if (!src) {
                    img.remove();
                    return;
                }
                img.addEventListener('error', () => {
                    img.style.display = 'none';
                }, { once: true });
            });

            // 让标签/分类可点击（阻止卡片整体链接的默认跳转）
            card.querySelectorAll('.xhs-tag-pill[data-tag-name]').forEach((pill) => {
                pill.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    const tag = pill.getAttribute('data-tag-name');
                    if (!tag) return;
                    Utils.navigateTo(`/tag/${encodeURIComponent(tag)}`);
                }, true);
            });
            const catPill = card.querySelector('.xhs-cat-pill[data-category-href]');
            if (catPill) {
                catPill.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    const href = catPill.getAttribute('data-category-href');
                    if (!href) return;
                    Utils.navigateTo(href);
                }, true);
            }
            return card;
        },

        _pickTextCoverSticker(seed, info) {
            // 贴纸规则（按优先级，尽量稳定且有信息密度）：
            // 1) 置顶、精华
            // 2) 日记、投喂
            // 3) 热议/多人观看/多人点赞（阈值：回复>50 / 浏览>1000 / 点赞>200）
            // 4) 外链
            // 5) 新闻（热点新闻）
            // 6) 教务（本科生教务/研究生教务等）
            const safe = (v) => (typeof v === 'string' ? v.trim() : '');
            const tagNames = Array.isArray(info?.tagNames) ? info.tagNames.map((t) => safe(t)).filter(Boolean) : [];
            const tagSet = new Set(tagNames);
            const likes = Number(info?.likes) || 0;
            const replyNum = Number(info?.replyNum) || 0;
            const viewNum = Number(info?.viewNum) || 0;
            const featuredDomain = safe(info?.featuredDomain);
            const categoryName = safe(info?.categoryName);
            const categoryLabel = safe(info?.categoryLabel);

            if (info?.pinned) return '置顶';
            if (tagSet.has('精华') || tagSet.has('精华帖') || tagSet.has('精华贴') || tagSet.has('精品')) return '精华';

            if (tagSet.has('日记')) return '日记';
            if (tagNames.some((t) => t.includes('投喂'))) return '投喂';

            if (replyNum > 50) return '热议';
            if (viewNum > 1000) return '多人观看';
            if (likes > 200) return '多人点赞';

            if (featuredDomain) return '外链';

            if (tagSet.has('热点新闻') || categoryName === '热点新闻' || categoryLabel.includes('热点新闻')) return '新闻';

            if (tagNames.some((t) => t.includes('本科生教务') || t.includes('研究生教务') || t.includes('教务'))) return '教务';

            return '';
        },

        updateStickerForCard(el, likesOverride) {
            const cover = el?.querySelector?.('.xhs-cover');
            if (!cover) return;
            const tid = String(el.dataset?.tid || '');
            if (!tid) return;

            const tagNames = String(el.dataset?.tags || '').split('\n').map((t) => t.trim()).filter(Boolean);
            const pinned = String(el.dataset?.pinned || '') === '1';
            const featuredDomain = String(el.dataset?.featuredDomain || '');
            const categoryName = String(el.dataset?.categoryName || '');
            const replyNum = Utils.parseCount(el.dataset?.replyNum);
            const viewNum = Utils.parseCount(el.dataset?.viewNum);
            const categoryLabel = categoryName;

            const text = this._pickTextCoverSticker(tid, {
                pinned,
                tagNames,
                featuredDomain,
                categoryName,
                categoryLabel,
                replyNum,
                viewNum,
                likes: Number(likesOverride) || 0
            });

            const existing = cover.querySelector('.xhs-sticker');
            if (!text) {
                existing?.remove();
                return;
            }
            if (existing) {
                existing.textContent = text;
                return;
            }
            const sticker = document.createElement('span');
            sticker.className = 'xhs-sticker';
            sticker.textContent = text;
            cover.appendChild(sticker);
        },

        _generateTextCoverLayers(seed, watermarkEmoji) {
            const rand = Utils.seededRandom(seed + '_cover');
            let html = '';

            const pat1 = this.bgPatterns[Math.floor(rand() * this.bgPatterns.length)];
            html += `<span class="xhs-bg ${pat1}"></span>`;
            if (rand() < 0.35) {
                const pat2 = this.bgPatterns[Math.floor(rand() * this.bgPatterns.length)];
                html += `<span class="xhs-bg secondary ${pat2}"></span>`;
            }

            // 引号装饰：约 35% 概率出现
            if (rand() < 0.35) {
                html += `<span class="xhs-deco quote tl">“</span><span class="xhs-deco quote br">”</span>`;
            }

            // 斜向光带：约 40% 概率出现（可叠加一条弱的）
            if (rand() < 0.40) html += `<span class="xhs-deco band b1"></span>`;
            if (rand() < 0.22) html += `<span class="xhs-deco band b2"></span>`;

            // “胶带”装饰：约 28% 概率出现
            if (rand() < 0.28) html += `<span class="xhs-deco tape t1"></span>`;
            if (rand() < 0.18) html += `<span class="xhs-deco tape t2"></span>`;

            // 角落装饰：0-4 个，偏向 2-3 个
            const corners = ['tl', 'tr', 'bl', 'br'];
            const r = rand();
            let cornerCount;
            if (r < 0.05) cornerCount = 0;
            else if (r < 0.15) cornerCount = 1;
            else if (r < 0.50) cornerCount = 2;
            else if (r < 0.85) cornerCount = 3;
            else cornerCount = 4;
            const pickedCorners = [...corners].sort(() => rand() - 0.5).slice(0, cornerCount);
            for (const pos of pickedCorners) {
                const deco = this.cornerDecos[Math.floor(rand() * this.cornerDecos.length)];
                html += `<span class="xhs-deco corner ${pos}">${deco}</span>`;
            }

            // 线条装饰：最多两条
            const lineCount = rand() < 0.62 ? 1 : (rand() < 0.28 ? 2 : 0);
            const linePositions = ['line-t', 'line-b'];
            for (let i = 0; i < lineCount; i++) {
                const ch = this.lineChars[Math.floor(rand() * this.lineChars.length)];
                const count = 5 + Math.floor(rand() * 7);
                const pos = linePositions[i % linePositions.length];
                html += `<span class="xhs-deco line ${pos}">${ch.repeat(count)}</span>`;
            }

            // 大水印：多位置变体
            const posIdx = Math.floor(rand() * 4) + 1;
            html += `<span class="xhs-deco big p${posIdx}">${Utils.escapeHtml(watermarkEmoji || '✦')}</span>`;

            return html;
        },

        processText(text, seed) {
            const rand = Utils.seededRandom(seed);
            
            // 交大水源特色关键词
            const keywords = /闵行|徐汇|电院|机动|船建|安泰|保研|考研|选课|GPA|思源|东川路|二手|出|求购|拼车|合租|猫|狗/g;
            
            // 多样化强调（参考 LinuxDo 版的文本效果），按 seed 伪随机选择样式
            const styles = ['xhs-hl', 'xhs-ul', 'xhs-wave', 'xhs-dot', 'xhs-bd'];
            return text.replace(keywords, (match) => {
                const style = styles[Math.floor(rand() * styles.length)];
                return `<span class="${style}">${match}</span>`;
            });
        }
    };

    /* ============================================
     * 5. 主程序
     * ============================================ */
    const App = {
        init() {
            // 注入基础UI
            Styles.injectBase();
            this.createFloatBtn();
            this.createPanel();
            
            // 进帖 -> 返回：记录滚动位置与点击的 tid（仅列表页）
            window.addEventListener('scroll', Utils.debounce(() => {
                try {
                    if (!document.body.classList.contains('xhs-on')) return;
                    if (!Utils.isListLikePath()) return;
                    Utils.saveListScrollState({ y: window.scrollY });
                } catch {}
            }, 180));
            document.addEventListener('click', (e) => {
                try {
                    if (!document.body.classList.contains('xhs-on')) return;
                    if (!Utils.isListLikePath()) return;
                    const a = e.target?.closest?.('a.xhs-card-link, a.xhs-title');
                    if (!a) return;
                    const card = a.closest?.('.xhs-card[data-tid]');
                    const tid = card?.getAttribute?.('data-tid') || '';
                    Utils.saveListScrollState({ y: window.scrollY, tid });
                } catch {}
            }, true);

            // 应用配置
            this.applyConfig();
            
            // 路由监听（减少轮询）
            const onRouteChanged = Utils.debounce(() => this.checkPage(), 80);
            const patchHistory = (methodName) => {
                const original = history[methodName];
                if (typeof original !== 'function') return;
                history[methodName] = function (...args) {
                    const ret = original.apply(this, args);
                    window.dispatchEvent(new Event('xhs-route-change'));
                    return ret;
                };
            };
            patchHistory('pushState');
            patchHistory('replaceState');
            const fireRouteChanged = () => window.dispatchEvent(new Event('xhs-route-change'));
            window.addEventListener('popstate', fireRouteChanged);
            window.addEventListener('xhs-route-change', onRouteChanged);
            // Discourse/主题有时会派发自定义事件，作为额外兜底
            document.addEventListener('discourse:page-changed', fireRouteChanged);
            document.addEventListener('page:changed', fireRouteChanged);
            document.addEventListener('turbo:load', fireRouteChanged);
            window.addEventListener('hashchange', fireRouteChanged);
            // BFCache / 回退恢复：有些情况下 popstate 不可靠，这里兜底触发一次检查
            window.addEventListener('pageshow', (e) => {
                try { if (e && e.persisted) this.lastUrl = ''; } catch {}
                fireRouteChanged();
            });
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) fireRouteChanged();
            });
            // 低频兜底：若列表已加载但未触发路由事件，则补一次渲染（避免高频轮询）
            setInterval(() => {
                try {
                    const cfg = Config.get();
                    if (!cfg.enabled) return;
                    if (!Utils.isListLikePath()) return;
                    if (Utils.getTopicRows().length === 0) return;
                    if (document.body.classList.contains('xhs-on')) return;
                    fireRouteChanged();
                } catch {}
            }, 5000);
            // 初次检查
            onRouteChanged();
        },

        lastUrl: '',
        pendingRenderRetryTimer: null,
        pendingRenderRetryCount: 0,
        restoredForKey: '',

        tryRenderListPage() {
            const cfg = Config.get();
            if (!cfg.enabled) return;
            if (!Utils.isListLikePath()) return;

            // Discourse SPA 下，列表内容可能在 DOMContentLoaded 之后才异步渲染。
            // 因此这里做有限次重试，避免引入高频 setInterval 轮询。
            const hasRows = Utils.getTopicRows().length > 0;
            if (!hasRows) {
                this.pendingRenderRetryCount += 1;
                if (this.pendingRenderRetryCount > 25) return;
                clearTimeout(this.pendingRenderRetryTimer);
                this.pendingRenderRetryTimer = setTimeout(() => this.tryRenderListPage(), 200);
                return;
            }

            this.pendingRenderRetryCount = 0;
            clearTimeout(this.pendingRenderRetryTimer);
            this.pendingRenderRetryTimer = null;

            document.body.classList.add('xhs-on');
            document.querySelector('.xhs-grid')?.remove();
            Grid.container = null;
            // 回到列表页时，Discourse 可能复用旧的 row DOM；清掉处理标记，避免“有 grid 但无 cards”
            try {
                Utils.getTopicRows().forEach((row) => {
                    row.classList.remove('xhs-processed');
                    delete row.dataset.xhsProcessedTid;
                });
            } catch {}
            Grid.render();

            // 返回列表页时尽量恢复到之前位置（先找 tid，再用 scrollY 兜底）
            try {
                const key = Utils.getListKey();
                if (this.restoredForKey !== key) {
                    this.restoredForKey = key;
                    const state = Utils.loadListScrollState();
                    if (state?.tid) {
                        const target = document.querySelector(`.xhs-card[data-tid="${CSS.escape(String(state.tid))}"]`);
                        if (target) {
                            setTimeout(() => {
                                try {
                                    target.scrollIntoView({ block: 'center' });
                                    target.classList.add('xhs-restore-highlight');
                                    setTimeout(() => target.classList.remove('xhs-restore-highlight'), 1800);
                                } catch {}
                            }, 0);
                            return;
                        }
                    }
                    if (typeof state?.y === 'number' && state.y > 0) {
                        setTimeout(() => {
                            try { window.scrollTo(0, state.y); } catch {}
                        }, 0);
                    }
                }
            } catch {}
        },

        checkPage() {
            if (location.href === this.lastUrl) return;
            this.lastUrl = location.href;

            document.body.classList.remove('xhs-on');
            this.pendingRenderRetryCount = 0;
            clearTimeout(this.pendingRenderRetryTimer);
            this.pendingRenderRetryTimer = null;
            if (!Utils.isListLikePath()) this.restoredForKey = '';

            if (Config.get().enabled) {
                // 只要是“列表类路径”，就尝试渲染；内部会等 rows 出现再真正生效。
                this.tryRenderListPage();
            }
        },

        applyConfig() {
            const cfg = Config.get();
            EarlyStyles.cacheEnabled(cfg.enabled);
            document.body.dataset.xhsShowStats = cfg.showStats ? '1' : '0';
            
            if (cfg.enabled) {
                document.body.classList.remove('xhs-on');
                Styles.injectTheme();
                if (Utils.isListLikePath()) {
                    if (Grid.container) {
                        Grid.container.classList.toggle('grid-mode', !cfg.cardStagger);
                    }
                    this.tryRenderListPage();
                }
            } else {
                document.body.classList.remove('xhs-on');
                Styles.removeTheme();
                document.querySelector('.xhs-grid')?.remove();
                Grid.container = null;
            }

            // 早期防闪烁样式仅用于首屏，配置已应用后立即移除，避免影响其它页面（如消息页）。
            EarlyStyles.remove();

            // 调试模式：暴露有限的诊断接口
            try {
                if (cfg.debugMode) {
                    window.__xhsDebug = {
                        version: VERSION,
                        state: () => ({
                            href: location.href,
                            listKey: Utils.getListKey(),
                            isListLike: Utils.isListLikePath(),
                            bodyClass: document.body?.className || '',
                            rows: Utils.getTopicRows().length,
                            cards: document.querySelectorAll('.xhs-card').length,
                            cols: (Grid._getDirectColumns?.() || []).length,
                            gridMode: Boolean(Grid.container?.classList?.contains?.('grid-mode')),
                            queue: Grid.queue?.length || 0,
                            cacheSize: Grid.cache?.size || 0,
                            persistentSize: Grid.persistentCache?.size || 0,
                            persistDirty: Grid.persistDirty || false,
                            rateLimit: Grid.rateLimit || null
                        }),
                        clearPersistentCache: () => {
                            try { GM_setValue('xhs_topic_cache_v1', '{}'); } catch {}
                            try { Grid.persistentCache = null; Grid.loadPersistentCache(); } catch {}
                            return true;
                        },
                        rerender: () => { try { Grid.render(); } catch {} return true; }
                    };
                } else {
                    delete window.__xhsDebug;
                }
            } catch {}
        },

        createFloatBtn() {
            const btn = document.createElement('div');
            btn.className = 'xhs-float-btn';
            btn.title = '小L书设置';
            // 使用水源Logo
            const iconUrl = 'https://shuiyuan.sjtu.edu.cn/uploads/default/original/4X/3/6/7/367cb152ca2cc40f1cf3e7ede4ff8069727167cc_2_180x180.png';
            btn.innerHTML = `<img src="${iconUrl}" alt="设置" />`;
            const iconImg = btn.querySelector('img');
            iconImg.onerror = () => {
                btn.innerHTML = `<span class="xhs-float-btn-fallback">⚙️</span>`;
            };
            btn.onclick = (e) => {
                e.preventDefault?.();
                const overlay = document.querySelector('.xhs-panel-overlay');
                const panel = overlay?.querySelector('.xhs-panel');
                overlay?.classList.add('show');
                panel?.classList.add('show');
            };
            document.body.appendChild(btn);
        },

        createPanel() {
            const overlay = document.createElement('div');
            overlay.className = 'xhs-panel-overlay';
            
            const panel = document.createElement('div');
            panel.className = 'xhs-panel';
            
            const render = () => {
                const cfg = Config.get();
                panel.innerHTML = `
                    <div class="xhs-panel-header">
                        <span>水源小L书 v${VERSION}</span>
                        <span class="xhs-panel-close">×</span>
                    </div>
                    <div class="xhs-panel-body">
                        <div class="xhs-row">
                            <div>
                                <div>启用小L书模式</div>
                                <div class="xhs-desc">开启瀑布流布局</div>
                            </div>
                            <div class="xhs-switch ${cfg.enabled?'on':''}" data-key="enabled"></div>
                        </div>
                        <div class="xhs-row">
                            <div>
                                <div>卡片错落布局</div>
                                <div class="xhs-desc">根据内容高度自适应</div>
                            </div>
                            <div class="xhs-switch ${cfg.cardStagger?'on':''}" data-key="cardStagger"></div>
                        </div>
                        <div class="xhs-row">
                            <div>
                                <div>列数</div>
                                <div class="xhs-desc">桌面端基准列数（移动端会自动降到 2-3 列）</div>
                            </div>
                            <input class="xhs-input" type="number" min="2" max="8" step="1" value="${cfg.columnCount}" data-input="columnCount" />
                        </div>
                        <div class="xhs-row">
                            <div>
                                <div>显示统计数据</div>
                                <div class="xhs-desc">回复数、点赞数</div>
                            </div>
                            <div class="xhs-switch ${cfg.showStats?'on':''}" data-key="showStats"></div>
                        </div>
                        <div class="xhs-row">
                            <div>
                                <div>跨页面缓存</div>
                                <div class="xhs-desc">缓存封面/点赞信息，减少重复请求</div>
                            </div>
                            <div class="xhs-switch ${cfg.cacheEnabled?'on':''}" data-key="cacheEnabled"></div>
                        </div>
                        <div class="xhs-row">
                            <div>
                                <div>缓存有效期（分钟）</div>
                                <div class="xhs-desc">过期后会重新请求（建议 15~180）</div>
                            </div>
                            <input class="xhs-input" type="number" min="1" max="1440" step="1" value="${cfg.cacheTtlMinutes}" data-input="cacheTtlMinutes" />
                        </div>
                        <div class="xhs-row">
                            <div>
                                <div>缓存容量（条目）</div>
                                <div class="xhs-desc">超过后按最近使用自动淘汰</div>
                            </div>
                            <input class="xhs-input" type="number" min="50" max="5000" step="10" value="${cfg.cacheMaxEntries}" data-input="cacheMaxEntries" />
                        </div>
                        <div class="xhs-row">
                            <div>
                                <div>调试模式</div>
                                <div class="xhs-desc">打开后会暴露 window.__xhsDebug（用于排查回退/缓存/渲染问题）</div>
                            </div>
                            <div class="xhs-switch ${cfg.debugMode?'on':''}" data-key="debugMode"></div>
                        </div>
                        
                        <div style="margin-top:20px; font-weight:600; margin-bottom:10px;">主题颜色</div>
                        <div class="xhs-colors">
                            ${Object.entries(Config.themes).map(([k,v]) => `
                                <div class="xhs-color-item ${cfg.themeColor===v?'active':''}" 
                                     style="background:${v}" 
                                     title="${k}"
                                     data-color="${v}"></div>
                            `).join('')}
                        </div>
                        
                        <div style="margin-top:20px; text-align:center; color:#999; font-size:12px;">
                            <span class="xhs-reset" style="cursor:pointer;text-decoration:underline">重置设置</span>
                        </div>
                    </div>
                `;
                
                // 绑定关闭事件
                panel.querySelector('.xhs-panel-close').onclick = (e) => {
                    e.preventDefault?.();
                    overlay.classList.remove('show');
                    panel.classList.remove('show');
                };

                // 绑定配置项点击（避免依赖 inline onclick，兼容更严格 CSP）
                const toggleKey = (k) => {
                    const c = Config.get();
                    Config.set(k, !c[k]);
                    render();
                    App.applyConfig();
                };
                panel.querySelectorAll('.xhs-switch[data-key]').forEach((sw) => {
                    sw.onclick = () => toggleKey(sw.getAttribute('data-key'));
                });
                panel.querySelectorAll('input.xhs-input[data-input]').forEach((input) => {
                    input.oninput = Utils.debounce(() => {
                        const k = input.getAttribute('data-input');
                        const v = parseInt(input.value, 10);
                        Config.set(k, v);
                        render();
                        App.applyConfig();
                    }, 120);
                });
                panel.querySelectorAll('.xhs-color-item[data-color]').forEach((item) => {
                    item.onclick = () => {
                        const c = item.getAttribute('data-color');
                        Config.set('themeColor', c);
                        render();
                        Styles.injectTheme();
                    };
                });
                panel.querySelector('.xhs-reset').onclick = () => {
                    if (confirm('重置所有设置？')) {
                        Config.reset();
                        location.reload();
                    }
                };
            };
            
            render();
            overlay.appendChild(panel);
            document.body.appendChild(overlay);
            
            overlay.onclick = (e) => {
                if (e.target === overlay) {
                    overlay.classList.remove('show');
                    panel.classList.remove('show');
                }
            };
        }
    };

    // 启动
    const bootstrap = () => {
        if (!document.body) return;
        try { document.documentElement.setAttribute('data-xhs-shuiyuan-version', VERSION); } catch {}
        App.init();
        Grid.init();
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    } else {
        bootstrap();
    }

})();
