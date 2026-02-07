// ==UserScript==
// @name         小水书
// @namespace    http://tampermonkey.net/
// @version      1.3.0
// @description  瀑布流排版，自动提取帖子正文图片作为封面，内置设置面板
// @author       十一世纪，codex
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
// @license      MIT
// @downloadURL  https://update.greasyfork.org/scripts/561704/%E5%B0%8F%E6%B0%B4%E4%B9%A6.user.js
// @updateURL    https://update.greasyfork.org/scripts/561704/%E5%B0%8F%E6%B0%B4%E4%B9%A6.meta.js
// ==/UserScript==

(function () {
    'use strict';

    // Safari Userscripts 等环境可能不提供 GM_* API：在脚本内部做最小兼容层兜底。
    // - Tampermonkey：直接走原生 GM_*。
    // - 无 GM_*：退化到 localStorage（或内存）存储 + DOM <style> 注入。
    const __xhsMemStore = new Map();
    const __xhsStorageKey = (k) => `__xhs_gm__${String(k || '')}`;
    const GM_getValue = (typeof window.GM_getValue === 'function')
        ? window.GM_getValue.bind(window)
        : (key, defaultValue) => {
            try {
                const v = localStorage.getItem(__xhsStorageKey(key));
                return v === null ? defaultValue : v;
            } catch {
                return __xhsMemStore.has(key) ? __xhsMemStore.get(key) : defaultValue;
            }
        };
    const GM_setValue = (typeof window.GM_setValue === 'function')
        ? window.GM_setValue.bind(window)
        : (key, value) => {
            try {
                localStorage.setItem(__xhsStorageKey(key), String(value));
            } catch {
                __xhsMemStore.set(key, value);
            }
        };
    const GM_addStyle = (typeof window.GM_addStyle === 'function')
        ? window.GM_addStyle.bind(window)
        : (css) => {
            try {
                const style = document.createElement('style');
                style.textContent = String(css || '');
                (document.head || document.documentElement).appendChild(style);
                return style;
            } catch {
                return null;
            }
        };

    if (window.__xhsShuiyuanLoaded) return;
    window.__xhsShuiyuanLoaded = true;

    const VERSION = '1.3.0';

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
                path.startsWith('/hot') ||
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
            statsAlign: 'justify', // 统计对齐：left/right/justify（主要用于宽松型布局的 xhs-stats）
            showStatLastActivity: true,
            showStatReplies: true,
            showStatLikes: true,
            showStatViews: true,
            stickerEnabled: true, // 封面贴纸（置顶/精华/热议…；关注话题可优先显示未读）
            showUnreadPosts: true, // 跟踪/关注话题显示未读数（也可用于覆盖贴纸）
            darkMode: 'auto', // 深色模式：auto(跟随站点/系统)/dark/light
            cardStagger: true, // 错落布局
            gridCardAspectRatio: 1.0, // 卡片长宽比（宽/高；仅“非错落布局”生效）
            columnCount: 4, // 列数（桌面端基准）
            metaLayout: 'spacious', // 元信息布局：compact(紧凑单行)/spacious(宽松两行)
            authorDisplay: 'full', // 贴主展示：full/avatar/name
            pillScale: 1.00, // 分类/标签 pill 的大小缩放（1.00=原始）
            pillOpacity: 1.00, // 分类/标签 pill 的背景不透明度倍率（仅影响封面左上角 pill；1.00=默认）
            topicReplyCards: false, // 帖子页回复卡片化：将楼层包装为更“卡片”的视觉层级
            topicReplyCardsBodyPaddingLeft: 14, // 帖子页回复卡片化：正文区域左侧留白（px）
            topicScrollKeepPosition: true, // 帖子页向上加载更多时保持当前位置（减少跳楼）
            coverPillsEnabled: true, // 封面左上角分类/标签 pill
            keywordHighlightEnabled: true, // 关键词突出显示
            keywordHighlightStyle: 'random', // random/hl/ul/wave/dot/bd
            keywordHighlightLexicon: '闵行\n徐汇\n电院\n机动\n船建\n安泰\n保研\n考研\n选课\nGPA\n思源\n东川路\n二手\n求购\n拼车\n合租\n猫\n狗',
            textCoverStyle: 'classic', // 文字封面风格：classic/notebook/glass/collage/mix_custom
            textCoverMixPool: ['classic', 'notebook', 'glass'], // 自定义混合池（仅 mix_custom 生效）
            cacheEnabled: true, // 跨页面缓存
            cacheTtlMinutes: 20160, // 缓存有效期（分钟）- 14天
            cacheMaxEntries: 300, // 缓存条目上限
            overfetchMode: true, // 过加载模式：扩大预取范围（可能增加请求）
            imgCropEnabled: true, // 智能裁剪封面（仅极端宽/长图才裁剪）
            imgCropBaseRatio: 1.78, // 裁剪基准比例（宽/高）
            listNoticeSpacingMode: 'smart', // “查看x个新的或更新的话题”提示避让：smart/legacy/off
            rateLimitEnabled: true, // 请求速率限制（降低 429 风险）
            rateMinIntervalMs: 350, // 最小请求间隔（毫秒）
            rateCooldownSeconds: 3, // 遇到 429 的冷却秒数（与 Retry-After 取较大值）
            rateAutoTune: true, // 遇到 429 自动放慢，成功后缓慢恢复
            debugMode: true, // 调试模式（仅用于排查问题）
            settingsIconStyle: 'shuiyuan', // 设置按钮图标：shuiyuan/xhsText/grid
            settingsIconSize: 20, // 设置按钮图标大小（px）
            settingsIconXhsText: '小水书', // xhsText 样式文案
            settingsIconTextScale: 1.25, // xhsText 字体缩放（影响留白）
            settingsIconGradientTop: '#33CCFF',
            settingsIconGradientBottom: '#0066CC',
            settingsIconGridColor: '#B5B5B5', // grid 样式 SVG 配色（使用 currentColor）
            settingsIconGearColor: '#BDBDBD', // “设置齿轮”SVG 配色（使用 fill 直写颜色）
            hiddenCoverTopics: {}, // 按帖子隐藏主楼图：{ [tid]: title }
            hiddenCoverTopicStyles: {}, // 按帖子覆盖文字封面风格：{ [tid]: classic/notebook/glass/collage }
            panelCollapsed: { layout: false, stats: false, cache: false, images: false, advanced: true, theme: false } // 设置面板折叠状态
        },
        themes: {
            '交大红': '#C8102E',
            '水源蓝': '#0085CA', // 稍微亮一点的蓝
            '活力橙': '#fa541c',
            '清新绿': '#52c41a',
            '神秘紫': '#722ed1',
            '少女粉': '#eb2f96'
        },
        normalizeHiddenCoverTopics(raw) {
            const out = {};
            if (!raw || typeof raw !== 'object') return out;
            let count = 0;
            for (const [key, value] of Object.entries(raw)) {
                if (count >= 1000) break;
                const tid = String(key || '').trim();
                if (!/^\d{1,18}$/u.test(tid)) continue;
                const title = String(value || '').trim().slice(0, 120);
                out[tid] = title;
                count += 1;
            }
            return out;
        },
        normalizeHiddenCoverTopicStyles(raw) {
            const out = {};
            if (!raw || typeof raw !== 'object') return out;
            const allowed = new Set(['classic', 'notebook', 'glass', 'collage']);
            let count = 0;
            for (const [key, value] of Object.entries(raw)) {
                if (count >= 1000) break;
                const tid = String(key || '').trim();
                if (!/^\d{1,18}$/u.test(tid)) continue;
                const style = String(value || '').trim();
                if (!allowed.has(style)) continue;
                out[tid] = style;
                count += 1;
            }
            return out;
        },
        normalizeKeywordHighlightStyle(raw) {
            const style = String(raw || '').trim();
            if (style === 'glow') return 'hl'; // 兼容旧配置
            const allowed = new Set(['random', 'hl', 'ul', 'wave', 'dot', 'bd']);
            return allowed.has(style) ? style : this.defaults.keywordHighlightStyle;
        },
        normalizeKeywordHighlightLexicon(raw) {
            const source = Array.isArray(raw) ? raw.join('\n') : String(raw ?? '');
            const lines = source.replace(/\r\n?/g, '\n').split('\n');
            const out = [];
            const seen = new Set();
            for (const line of lines) {
                const pieces = String(line || '').split(/[，,;；]/u);
                for (const item of pieces) {
                    const keyword = String(item || '').trim().slice(0, 32);
                    if (!keyword || seen.has(keyword)) continue;
                    seen.add(keyword);
                    out.push(keyword);
                    if (out.length >= 200) return out;
                }
            }
            return out;
        },
        normalizeTextCoverMixPool(raw) {
            const allowed = ['classic', 'notebook', 'glass', 'collage'];
            const arr = Array.isArray(raw)
                ? raw
                : (typeof raw === 'string'
                    ? raw.split(',')
                    : ((raw && typeof raw === 'object')
                        ? Object.keys(raw).filter((k) => raw[k])
                        : []));
            const set = new Set();
            for (const item of arr) {
                const style = String(item || '').trim();
                if (!allowed.includes(style) || set.has(style)) continue;
                set.add(style);
            }
            const out = allowed.filter((style) => set.has(style));
            return out.length ? out : [...this.defaults.textCoverMixPool];
        },
        get() {
            try {
                const cfg = { ...this.defaults, ...JSON.parse(GM_getValue(this.KEY, '{}')) };
                // 基本校验/归一化（避免脏数据导致样式/逻辑异常）
                cfg.columnCount = Math.min(50, Math.max(1, parseInt(cfg.columnCount, 10) || this.defaults.columnCount));
                cfg.metaLayout = (cfg.metaLayout === 'spacious' || cfg.metaLayout === 'compact') ? cfg.metaLayout : this.defaults.metaLayout;
                cfg.statsAlign = (cfg.statsAlign === 'left' || cfg.statsAlign === 'right' || cfg.statsAlign === 'justify') ? cfg.statsAlign : this.defaults.statsAlign;
                cfg.darkMode = (cfg.darkMode === 'auto' || cfg.darkMode === 'dark' || cfg.darkMode === 'light') ? cfg.darkMode : this.defaults.darkMode;
                cfg.authorDisplay = (cfg.authorDisplay === 'full' || cfg.authorDisplay === 'avatar' || cfg.authorDisplay === 'name') ? cfg.authorDisplay : this.defaults.authorDisplay;
                cfg.pillScale = (() => {
                    const n = parseFloat(cfg.pillScale);
                    if (!Number.isFinite(n)) return this.defaults.pillScale;
                    return Math.min(5, Math.max(0.5, n));
                })();
                cfg.pillOpacity = (() => {
                    const n = parseFloat(cfg.pillOpacity);
                    if (!Number.isFinite(n)) return this.defaults.pillOpacity;
                    return Math.min(1, Math.max(0.2, n));
                })();
                cfg.gridCardAspectRatio = (() => {
                    const n = parseFloat(cfg.gridCardAspectRatio);
                    if (!Number.isFinite(n)) return this.defaults.gridCardAspectRatio;
                    return Math.min(3.0, Math.max(0.6, n));
                })();
                cfg.topicReplyCards = (typeof cfg.topicReplyCards === 'boolean') ? cfg.topicReplyCards : this.defaults.topicReplyCards;
                cfg.topicReplyCardsBodyPaddingLeft = (() => {
                    const n = parseInt(cfg.topicReplyCardsBodyPaddingLeft, 10);
                    if (!Number.isFinite(n)) return this.defaults.topicReplyCardsBodyPaddingLeft;
                    return Math.min(80, Math.max(0, n));
                })();
                cfg.topicScrollKeepPosition = (typeof cfg.topicScrollKeepPosition === 'boolean') ? cfg.topicScrollKeepPosition : this.defaults.topicScrollKeepPosition;
                cfg.coverPillsEnabled = (typeof cfg.coverPillsEnabled === 'boolean') ? cfg.coverPillsEnabled : this.defaults.coverPillsEnabled;
                cfg.settingsIconStyle = (cfg.settingsIconStyle === 'shuiyuan' || cfg.settingsIconStyle === 'xhsText' || cfg.settingsIconStyle === 'grid') ? cfg.settingsIconStyle : this.defaults.settingsIconStyle;
                cfg.settingsIconSize = (() => {
                    const n = parseInt(cfg.settingsIconSize, 10);
                    if (!Number.isFinite(n)) return this.defaults.settingsIconSize;
                    return Math.min(36, Math.max(14, n));
                })();
                cfg.settingsIconXhsText = String(cfg.settingsIconXhsText || this.defaults.settingsIconXhsText || '小水书').trim().slice(0, 6) || '小水书';
                cfg.settingsIconTextScale = (() => {
                    const n = parseFloat(cfg.settingsIconTextScale);
                    if (!Number.isFinite(n)) return this.defaults.settingsIconTextScale;
                    return Math.min(1.8, Math.max(0.8, n));
                })();
                const isHex = (s) => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(s || '').trim());
                cfg.settingsIconGradientTop = isHex(cfg.settingsIconGradientTop) ? String(cfg.settingsIconGradientTop).trim() : this.defaults.settingsIconGradientTop;
                cfg.settingsIconGradientBottom = isHex(cfg.settingsIconGradientBottom) ? String(cfg.settingsIconGradientBottom).trim() : this.defaults.settingsIconGradientBottom;
                cfg.settingsIconGridColor = isHex(cfg.settingsIconGridColor) ? String(cfg.settingsIconGridColor).trim() : this.defaults.settingsIconGridColor;
                cfg.settingsIconGearColor = isHex(cfg.settingsIconGearColor) ? String(cfg.settingsIconGearColor).trim() : this.defaults.settingsIconGearColor;
                cfg.hiddenCoverTopics = this.normalizeHiddenCoverTopics(cfg.hiddenCoverTopics);
                cfg.hiddenCoverTopicStyles = this.normalizeHiddenCoverTopicStyles(cfg.hiddenCoverTopicStyles);
                cfg.keywordHighlightEnabled = (typeof cfg.keywordHighlightEnabled === 'boolean') ? cfg.keywordHighlightEnabled : this.defaults.keywordHighlightEnabled;
                cfg.keywordHighlightStyle = this.normalizeKeywordHighlightStyle(cfg.keywordHighlightStyle);
                cfg.keywordHighlightLexicon = this.normalizeKeywordHighlightLexicon(cfg.keywordHighlightLexicon).join('\n');
                cfg.cacheTtlMinutes = Math.min(14 * 24 * 60, Math.max(1, parseInt(cfg.cacheTtlMinutes, 10) || this.defaults.cacheTtlMinutes));
                cfg.cacheMaxEntries = Math.min(5000, Math.max(50, parseInt(cfg.cacheMaxEntries, 10) || this.defaults.cacheMaxEntries));
                cfg.cacheEnabled = Boolean(cfg.cacheEnabled);
                cfg.showStats = Boolean(cfg.showStats);
                cfg.showStatLastActivity = (typeof cfg.showStatLastActivity === 'boolean') ? cfg.showStatLastActivity : cfg.showStats;
                cfg.showStatReplies = (typeof cfg.showStatReplies === 'boolean') ? cfg.showStatReplies : cfg.showStats;
                cfg.showStatLikes = (typeof cfg.showStatLikes === 'boolean') ? cfg.showStatLikes : cfg.showStats;
                cfg.showStatViews = (typeof cfg.showStatViews === 'boolean') ? cfg.showStatViews : false;
                cfg.stickerEnabled = (typeof cfg.stickerEnabled === 'boolean') ? cfg.stickerEnabled : this.defaults.stickerEnabled;
                cfg.showUnreadPosts = (typeof cfg.showUnreadPosts === 'boolean') ? cfg.showUnreadPosts : this.defaults.showUnreadPosts;
                cfg.enabled = Boolean(cfg.enabled);
                cfg.cardStagger = Boolean(cfg.cardStagger);
                cfg.overfetchMode = Boolean(cfg.overfetchMode);
                cfg.imgCropEnabled = Boolean(cfg.imgCropEnabled);
                const legacyStyle = String(cfg.textCoverStyle || '').trim();
                if (legacyStyle === 'vivid' || legacyStyle === 'editor' || legacyStyle === 'minimal') {
                    cfg.textCoverStyle = 'classic'; // 兼容旧版本风格值
                } else if (legacyStyle === 'mix_np' || legacyStyle === 'mix_all') {
                    cfg.textCoverStyle = 'mix_custom';
                } else if (legacyStyle === 'structured' || legacyStyle === 'poster' || legacyStyle === 'magazine' || legacyStyle === 'aura') {
                    cfg.textCoverStyle = 'classic';
                } else {
                    cfg.textCoverStyle = legacyStyle;
                }
                cfg.textCoverStyle =
                    (
                        cfg.textCoverStyle === 'classic' ||
                        cfg.textCoverStyle === 'notebook' ||
                        cfg.textCoverStyle === 'glass' ||
                        cfg.textCoverStyle === 'collage' ||
                        cfg.textCoverStyle === 'mix_custom'
                    )
                        ? cfg.textCoverStyle
                        : this.defaults.textCoverStyle;
                if (legacyStyle === 'mix_np' && !Array.isArray(cfg.textCoverMixPool)) {
                    cfg.textCoverMixPool = ['notebook', 'glass'];
                } else if (legacyStyle === 'mix_all' && !Array.isArray(cfg.textCoverMixPool)) {
                    cfg.textCoverMixPool = [...this.defaults.textCoverMixPool];
                }
                cfg.textCoverMixPool = this.normalizeTextCoverMixPool(cfg.textCoverMixPool);
                cfg.imgCropBaseRatio = (() => {
                    const n = parseFloat(cfg.imgCropBaseRatio);
                    if (!Number.isFinite(n)) return this.defaults.imgCropBaseRatio;
                    return Math.min(3.0, Math.max(0.6, n));
                })();
                cfg.listNoticeSpacingMode =
                    (cfg.listNoticeSpacingMode === 'smart' || cfg.listNoticeSpacingMode === 'legacy' || cfg.listNoticeSpacingMode === 'off')
                        ? cfg.listNoticeSpacingMode
                        : this.defaults.listNoticeSpacingMode;
                cfg.rateLimitEnabled = (typeof cfg.rateLimitEnabled === 'boolean') ? cfg.rateLimitEnabled : this.defaults.rateLimitEnabled;
                cfg.rateMinIntervalMs = Math.min(5000, Math.max(120, parseInt(cfg.rateMinIntervalMs, 10) || this.defaults.rateMinIntervalMs));
                cfg.rateCooldownSeconds = Math.min(60, Math.max(1, parseInt(cfg.rateCooldownSeconds, 10) || this.defaults.rateCooldownSeconds));
                cfg.rateAutoTune = (typeof cfg.rateAutoTune === 'boolean') ? cfg.rateAutoTune : this.defaults.rateAutoTune;
                cfg.debugMode = Boolean(cfg.debugMode);
                // 设置面板折叠状态
                try {
                    const pc = cfg.panelCollapsed;
                    const def = this.defaults.panelCollapsed || {};
                    cfg.panelCollapsed = {
                        layout: typeof pc?.layout === 'boolean' ? pc.layout : Boolean(def.layout),
                        stats: typeof pc?.stats === 'boolean' ? pc.stats : Boolean(def.stats),
                        cache: typeof pc?.cache === 'boolean' ? pc.cache : Boolean(def.cache),
                        images: typeof pc?.images === 'boolean' ? pc.images : Boolean(def.images),
                        advanced: typeof pc?.advanced === 'boolean' ? pc.advanced : Boolean(def.advanced),
                        theme: typeof pc?.theme === 'boolean' ? pc.theme : Boolean(def.theme),
                    };
                } catch { cfg.panelCollapsed = { ...this.defaults.panelCollapsed }; }
                return cfg;
            } catch { return this.defaults; }
        },
        set(k, v) {
            const cfg = this.get();
            cfg[k] = v;
            GM_setValue(this.KEY, JSON.stringify(cfg));
        },
        setCollapsedSection(sectionId, collapsed) {
            const id = String(sectionId || '').trim();
            if (!id) return;
            const cfg = this.get();
            const pc = cfg.panelCollapsed && typeof cfg.panelCollapsed === 'object' ? cfg.panelCollapsed : {};
            pc[id] = Boolean(collapsed);
            cfg.panelCollapsed = pc;
            GM_setValue(this.KEY, JSON.stringify(cfg));
        },
        isCoverHidden(tid) {
            const key = String(tid || '').trim();
            if (!key) return false;
            const map = this.get().hiddenCoverTopics || {};
            return Object.prototype.hasOwnProperty.call(map, key);
        },
        setCoverHidden(tid, title) {
            const key = String(tid || '').trim();
            if (!key) return;
            const cfg = this.get();
            const map = this.normalizeHiddenCoverTopics(cfg.hiddenCoverTopics);
            const nextTitle = String(title || map[key] || `话题 ${key}`).trim().slice(0, 120);
            map[key] = nextTitle;
            cfg.hiddenCoverTopics = map;
            GM_setValue(this.KEY, JSON.stringify(cfg));
        },
        unsetCoverHidden(tid) {
            const key = String(tid || '').trim();
            if (!key) return;
            const cfg = this.get();
            const map = this.normalizeHiddenCoverTopics(cfg.hiddenCoverTopics);
            delete map[key];
            cfg.hiddenCoverTopics = map;
            GM_setValue(this.KEY, JSON.stringify(cfg));
        },
        clearCoverHidden() {
            const cfg = this.get();
            cfg.hiddenCoverTopics = {};
            cfg.hiddenCoverTopicStyles = {};
            GM_setValue(this.KEY, JSON.stringify(cfg));
        },
        getCoverStyleOverride(tid) {
            const key = String(tid || '').trim();
            if (!key) return '';
            const map = this.get().hiddenCoverTopicStyles || {};
            const style = String(map[key] || '').trim();
            return (style === 'classic' || style === 'notebook' || style === 'glass' || style === 'collage') ? style : '';
        },
        setCoverStyleOverride(tid, style) {
            const key = String(tid || '').trim();
            const nextStyle = String(style || '').trim();
            if (!key) return;
            if (!(nextStyle === 'classic' || nextStyle === 'notebook' || nextStyle === 'glass' || nextStyle === 'collage')) return;
            const cfg = this.get();
            const map = this.normalizeHiddenCoverTopicStyles(cfg.hiddenCoverTopicStyles);
            map[key] = nextStyle;
            cfg.hiddenCoverTopicStyles = map;
            GM_setValue(this.KEY, JSON.stringify(cfg));
        },
        unsetCoverStyleOverride(tid) {
            const key = String(tid || '').trim();
            if (!key) return;
            const cfg = this.get();
            const map = this.normalizeHiddenCoverTopicStyles(cfg.hiddenCoverTopicStyles);
            delete map[key];
            cfg.hiddenCoverTopicStyles = map;
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
        getCssVar(name) {
            const k = String(name || '').trim();
            if (!k) return '';
            try {
                return getComputedStyle(document.documentElement).getPropertyValue(k).trim();
            } catch {
                return '';
            }
        },
        parseCssColorToRgb(color) {
            const s = String(color || '').trim();
            if (!s) return null;
            // #rgb / #rrggbb
            const hex3 = /^#([0-9a-f]{3})$/i.exec(s);
            if (hex3) {
                const h = hex3[1];
                const r = parseInt(h[0] + h[0], 16);
                const g = parseInt(h[1] + h[1], 16);
                const b = parseInt(h[2] + h[2], 16);
                return { r, g, b };
            }
            const hex6 = /^#([0-9a-f]{6})$/i.exec(s);
            if (hex6) {
                const h = hex6[1];
                const r = parseInt(h.slice(0, 2), 16);
                const g = parseInt(h.slice(2, 4), 16);
                const b = parseInt(h.slice(4, 6), 16);
                return { r, g, b };
            }
            // rgb()/rgba()
            const rgb = /^rgba?\(([^)]+)\)$/i.exec(s);
            if (rgb) {
                const parts = rgb[1].split(',').map((v) => parseFloat(v.trim()));
                if (parts.length >= 3 && parts.every((v) => Number.isFinite(v))) {
                    const r = Math.min(255, Math.max(0, parts[0]));
                    const g = Math.min(255, Math.max(0, parts[1]));
                    const b = Math.min(255, Math.max(0, parts[2]));
                    return { r, g, b };
                }
            }
            return null;
        },
        relativeLuminance(rgb) {
            const toLin = (c) => {
                const v = (Number(c) || 0) / 255;
                return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
            };
            const r = toLin(rgb?.r);
            const g = toLin(rgb?.g);
            const b = toLin(rgb?.b);
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        },
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
        formatStatCount(n) {
            n = parseInt(n) || 0;
            if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'm';
            if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
            return String(n);
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
        saveLastListUrl() {
            try {
                if (!this.isListLikePath()) return;
                const url = `${window.location.pathname}${window.location.search || ''}`;
                const payload = { url, ts: Date.now() };
                sessionStorage.setItem('xhs_last_list_url_v1', JSON.stringify(payload));
            } catch {}
        },
        loadLastListUrl() {
            try {
                const raw = sessionStorage.getItem('xhs_last_list_url_v1');
                if (!raw) return '';
                const obj = JSON.parse(raw);
                if (!obj || typeof obj !== 'object') return '';
                if (typeof obj.ts !== 'number' || (Date.now() - obj.ts) > 30 * 60 * 1000) return '';
                const url = String(obj.url || '');
                return url.startsWith('/') ? url : '';
            } catch {
                return '';
            }
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
            // Discourse 允许独立于系统切换主题：优先从站点 CSS 变量推断
            try {
                const bg = this.getCssVar('--secondary') || this.getCssVar('--header_background');
                const rgb = this.parseCssColorToRgb(bg);
                if (rgb) {
                    const lum = this.relativeLuminance(rgb);
                    // 背景亮度较低 => 深色主题
                    if (Number.isFinite(lum)) return lum < 0.45;
                }
            } catch {}
            return window.matchMedia?.('(prefers-color-scheme: dark)').matches;
        },
        escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        },
        escapeRegExp(str) {
            return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
                'shuiyuan-portal': '🌊',   // 水源广场
                'campus-life': '🏫',       // 校园生活
                'life-experience': '🧭',   // 人生经验
                'sjtu-study': '📚',        // 学在交大
                'culture-arts': '🎨',      // 文化艺术
                'leisure-entertainment': '🎮', // 休闲娱乐
                'technology': '💻',        // 数码科技
                'ads': '📢',               // 广而告之
                'clubs-organizations': '🤝',             // 社团组织
                'shuiyuan-affairs': '🛠️',      // 水源站务（待确认 slug）
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
                path.startsWith('/hot') ||
                path.startsWith('/categories') ||
                path.startsWith('/tag/') ||
                path.startsWith('/c/');
        },
        isTopicPath() {
            const path = window.location.pathname;
            return path.startsWith('/t/');
        },
        isPrivateMessageTopic() {
            if (!this.isTopicPath()) return false;
            try {
                const body = document.body;
                if (body?.classList?.contains('archetype-private_message')) return true;
                if (body?.classList?.contains('private-message-page')) return true;
            } catch {}
            try {
                if (document.querySelector('.topic-map__private-message-label, .private-message-glyph, .private-message')) return true;
            } catch {}
            return false;
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
        },
        sleep(ms) {
            const t = Number(ms) || 0;
            return new Promise((resolve) => setTimeout(resolve, Math.max(0, t)));
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
                /* 设置按钮：优先放到顶部导航（搜索按钮左侧），找不到则用右下角悬浮 */
                .xhs-float-btn { cursor: pointer; color: var(--xhs-settings-icon-color, var(--xhs-c, #C8102E)); }
                .xhs-float-btn.xhs-float-fixed {
                    position: fixed;
                    bottom: 20px;
                    bottom: max(16px, env(safe-area-inset-bottom));
                    right: 20px;
                    right: max(16px, env(safe-area-inset-right));
                    left: auto !important;
                    inset-inline-start: auto !important;
                    inset-inline-end: max(16px, env(safe-area-inset-right));
                    width: 48px;
                    height: 48px;
                    background: #fff;
                    border-radius: 50%;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                    z-index: 99999;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: transform 0.2s;
                    border: 2px solid var(--xhs-c, #C8102E);
                    --xhs-settings-icon-size: 28px;
                }
                body.xhs-dark .xhs-float-btn.xhs-float-fixed {
                    background: rgba(18,18,18,0.92);
                    box-shadow: 0 10px 28px rgba(0,0,0,0.55);
                }
                .xhs-float-btn.xhs-float-fixed:hover { transform: scale(1.1); }
                .xhs-float-btn.xhs-float-fixed img,
                .xhs-float-btn.xhs-float-fixed svg { width: var(--xhs-settings-icon-size, 28px); height: var(--xhs-settings-icon-size, 28px); object-fit: contain; display: block; }
                .xhs-float-btn.xhs-float-fixed .xhs-float-btn-fallback {
                    width: 28px;
                    height: 28px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 20px;
                    color: var(--xhs-c, #C8102E);
                }
                .xhs-settings-dropdown { display: flex; align-items: center; }
                .xhs-float-btn.xhs-float-header { --xhs-settings-icon-size: 20px; }
                .xhs-float-btn.xhs-float-header img,
                .xhs-float-btn.xhs-float-header svg { width: var(--xhs-settings-icon-size, 20px); height: var(--xhs-settings-icon-size, 20px); object-fit: contain; border-radius: 6px; display: block; }
                .xhs-float-btn.xhs-float-header .xhs-float-btn-fallback { font-size: 16px; color: var(--xhs-c, #C8102E); }

                /* 设置面板 */
                .xhs-panel-overlay {
                    position: fixed; inset: 0; background: rgba(0,0,0,0.45);
                    z-index: 99998; display: none; opacity: 0; transition: opacity 0.3s;
                    overscroll-behavior: contain;
                    backdrop-filter: blur(6px) saturate(120%);
                }
                .xhs-panel-overlay.show { display: block; opacity: 1; }
                
                .xhs-panel {
                    position: fixed; top: 50%; left: 50%;
                    transform: translate(-50%, -50%) scale(0.9);
                    width: min(420px, 92vw);
                    max-height: min(82vh, 760px);
                    background: #fff; border-radius: 16px;
                    z-index: 99999; opacity: 0; visibility: hidden;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                    transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
                    overflow: hidden;
                    /* Discourse 主题里可能已有同名 class，强制使用 flex 以保证 panel-body 可滚动 */
                    display: flex !important;
                    flex-direction: column !important;
                }
                .xhs-panel.show { opacity: 1; visibility: visible; transform: translate(-50%, -50%) scale(1); }
                body.xhs-dark .xhs-panel {
                    background: rgba(18,18,18,0.94);
                    border: 1px solid rgba(255,255,255,0.12);
                    box-shadow: 0 18px 60px rgba(0,0,0,0.55);
                }
                
                .xhs-panel-header {
                    padding: 16px 20px; background: var(--xhs-c); color: #fff;
                    display: flex; justify-content: space-between; align-items: center;
                    font-weight: 600;
                }
                .xhs-panel-close { cursor: pointer; font-size: 20px; opacity: 0.8; }
                .xhs-panel-close:hover { opacity: 1; }
                
                .xhs-panel-body {
                    padding: 16px;
                    overflow-y: auto;
                    flex: 1 1 auto;
                    min-height: 0; /* 关键：允许 flex 子项收缩以触发内部滚动 */
                    overscroll-behavior: contain;
                    -webkit-overflow-scrolling: touch;
                }
                
                .xhs-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    gap: 12px;
                    margin-bottom: 12px;
                    font-size: 14px;
                    color: #333;
                }
                body.xhs-dark .xhs-row { color: rgba(255,255,255,0.92); }
                .xhs-row > div:first-child { min-width: 0; }
                .xhs-desc { font-size: 12px; color: #999; margin-top: 3px; line-height: 1.2; }
                body.xhs-dark .xhs-desc { color: rgba(255,255,255,0.62); }
                .xhs-section {
                    background: rgba(255,255,255,0.92);
                    border: 1px solid rgba(0,0,0,0.06);
                    border-radius: 14px;
                    padding: 12px;
                    margin-bottom: 12px;
                    box-shadow: inset 0 1px 0 rgba(255,255,255,0.65);
                }
                body.xhs-dark .xhs-section {
                    background: rgba(0,0,0,0.18);
                    border: 1px solid rgba(255,255,255,0.10);
                    box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
                }
                .xhs-section-title {
                    font-weight: 800;
                    font-size: 12px;
                    letter-spacing: 0.4px;
                    color: rgba(0,0,0,0.55);
                    text-transform: uppercase;
                    margin-bottom: 10px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    cursor: pointer;
                    user-select: none;
                }
                body.xhs-dark .xhs-section-title { color: rgba(255,255,255,0.72); }
                .xhs-section-title::before {
                    content: '';
                    width: 10px;
                    height: 10px;
                    border-radius: 999px;
                    background: rgba(var(--xhs-rgb), 0.70);
                    box-shadow: 0 0 0 4px rgba(var(--xhs-rgb), 0.15);
                    flex: 0 0 auto;
                }
                .xhs-section-title::after {
                    content: '▾';
                    margin-left: auto;
                    opacity: 0.7;
                    transform: translateY(-1px);
                }
                .xhs-section.xhs-collapsed .xhs-section-title::after { content: '▸'; }
                .xhs-section-body { display: block; }
                .xhs-section.xhs-collapsed .xhs-section-body { display: none; }
                .xhs-section .xhs-row { margin-bottom: 0; padding: 10px 0; }
                .xhs-section .xhs-row + .xhs-row { border-top: 1px solid rgba(0,0,0,0.06); }
                body.xhs-dark .xhs-section .xhs-row + .xhs-row { border-top: 1px solid rgba(255,255,255,0.08); }
                .xhs-section .xhs-input, .xhs-section .xhs-btn { flex: 0 0 auto; }
                .xhs-section-actions { display: flex; justify-content: center; padding-top: 6px; }
                .xhs-btn {
                    padding: 6px 10px;
                    border-radius: 10px;
                    border: 1px solid rgba(0,0,0,0.12);
                    background: rgba(255,255,255,0.95);
                    color: #333;
                    cursor: pointer;
                }
                body.xhs-dark .xhs-btn {
                    border: 1px solid rgba(255,255,255,0.16);
                    background: rgba(0,0,0,0.25);
                    color: rgba(255,255,255,0.9);
                }
                .xhs-btn.danger {
                    border-color: rgba(var(--xhs-rgb), 0.45);
                    color: var(--xhs-c);
                }
                .xhs-hidden-cover-list {
                    margin-top: 8px;
                    border: 1px solid rgba(0,0,0,0.08);
                    border-radius: 12px;
                    max-height: 180px;
                    overflow: auto;
                    background: rgba(255,255,255,0.82);
                }
                body.xhs-dark .xhs-hidden-cover-list {
                    border: 1px solid rgba(255,255,255,0.12);
                    background: rgba(0,0,0,0.22);
                }
                .xhs-hidden-cover-item {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 8px 10px;
                    font-size: 12px;
                    color: #444;
                    transition: background 0.15s ease;
                }
                .xhs-hidden-cover-item:hover { background: rgba(var(--xhs-rgb), 0.06); }
                body.xhs-dark .xhs-hidden-cover-item { color: rgba(255,255,255,0.88); }
                body.xhs-dark .xhs-hidden-cover-item:hover { background: rgba(255,255,255,0.06); }
                .xhs-hidden-cover-item + .xhs-hidden-cover-item {
                    border-top: 1px solid rgba(0,0,0,0.06);
                }
                body.xhs-dark .xhs-hidden-cover-item + .xhs-hidden-cover-item {
                    border-top: 1px solid rgba(255,255,255,0.08);
                }
                .xhs-hidden-cover-title {
                    flex: 1 1 auto;
                    min-width: 0;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    color: inherit;
                    text-decoration: none;
                }
                .xhs-hidden-cover-title:hover { color: var(--xhs-c); text-decoration: underline; }
                .xhs-hidden-cover-tid {
                    opacity: 0.65;
                    font-size: 11px;
                    margin-left: 4px;
                }
                .xhs-btn.xhs-mini-btn {
                    padding: 4px 8px;
                    border-radius: 8px;
                    font-size: 12px;
                }
                .xhs-row .xhs-input {
                    width: 88px;
                    padding: 6px 8px;
                    border-radius: 10px;
                    border: 1px solid rgba(0,0,0,0.12);
                    background: rgba(255,255,255,0.95);
                    color: #333;
                }
                .xhs-row .xhs-input.xhs-textarea {
                    width: 100%;
                    min-height: 96px;
                    resize: vertical;
                    line-height: 1.45;
                    font-size: 12px;
                    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
                }
                body.xhs-dark .xhs-row .xhs-input {
                    border: 1px solid rgba(255,255,255,0.16);
                    background: rgba(0,0,0,0.25);
                    color: rgba(255,255,255,0.9);
                }
                .xhs-inline-actions {
                    margin-top: 8px;
                    display: flex;
                    gap: 8px;
                    flex-wrap: wrap;
                }
                .xhs-style-preview-grid {
                    display: grid;
                    grid-template-columns: repeat(5, minmax(0, 1fr));
                    gap: 8px;
                    width: 100%;
                    margin-top: 8px;
                }
                .xhs-style-preview-item {
                    appearance: none;
                    -webkit-appearance: none;
                    position: relative;
                    border: 1px solid rgba(0,0,0,0.10);
                    border-radius: 10px;
                    height: 48px;
                    background: #f6f7fb;
                    cursor: pointer;
                    overflow: hidden;
                    padding: 4px 6px;
                    color: #333;
                    display: flex;
                    align-items: flex-end;
                    justify-content: space-between;
                    font-size: 10px;
                    font-weight: 700;
                    transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
                }
                .xhs-style-preview-item:hover {
                    transform: translateY(-1px);
                    border-color: rgba(var(--xhs-rgb), 0.45);
                    box-shadow: 0 4px 10px rgba(0,0,0,0.08);
                }
                .xhs-style-preview-item.active {
                    border-color: rgba(var(--xhs-rgb), 0.78);
                    box-shadow: 0 0 0 2px rgba(var(--xhs-rgb), 0.18);
                }
                body.xhs-dark .xhs-style-preview-item {
                    border: 1px solid rgba(255,255,255,0.14);
                    background: rgba(255,255,255,0.04);
                    color: rgba(255,255,255,0.92);
                }
                body.xhs-dark .xhs-style-preview-item.active {
                    border-color: rgba(var(--xhs-rgb), 0.92);
                    box-shadow: 0 0 0 2px rgba(var(--xhs-rgb), 0.28);
                }
                .xhs-style-preview-item::before {
                    content: '';
                    position: absolute;
                    inset: 0;
                    pointer-events: none;
                }
                .xhs-style-preview-item[data-style="classic"]::before {
                    background:
                        linear-gradient(145deg, rgba(var(--xhs-rgb), 0.16), rgba(0,0,0,0)),
                        linear-gradient(180deg, rgba(255,255,255,0.58), rgba(0,0,0,0)),
                        #f8f9ff;
                }
                .xhs-style-preview-item[data-style="notebook"]::before {
                    background:
                        linear-gradient(rgba(130,142,160,0.22) 1px, transparent 1px),
                        linear-gradient(90deg, rgba(130,142,160,0.18) 1px, transparent 1px),
                        #f7f9fc;
                    background-size: 10px 10px, 10px 10px, 100% 100%;
                }
                .xhs-style-preview-item[data-style="glass"]::before {
                    background:
                        linear-gradient(160deg, rgba(255,255,255,0.72), rgba(255,255,255,0.08) 56%),
                        radial-gradient(circle at 18% 16%, rgba(var(--xhs-rgb), 0.16), rgba(0,0,0,0) 46%),
                        #e9f0fa;
                }
                .xhs-style-preview-item[data-style="collage"]::before {
                    background:
                        radial-gradient(rgba(0,0,0,0.30) 1px, transparent 1px),
                        linear-gradient(165deg, #ffe55b, #ffd800);
                    background-size: 8px 8px, 100% 100%;
                }
                .xhs-style-preview-item[data-style="mix_custom"]::before {
                    background: conic-gradient(from 90deg, #f8f9ff, #f7f9fc, #e9f0fa, #ffe55b, #f8f9ff);
                }
                .xhs-style-preview-item .xhs-style-preview-label,
                .xhs-style-preview-item .xhs-style-preview-sub {
                    position: relative;
                    z-index: 1;
                    text-shadow: 0 1px 1px rgba(255,255,255,0.45);
                    white-space: nowrap;
                }
                .xhs-style-preview-item .xhs-style-preview-sub {
                    font-size: 9px;
                    opacity: 0.68;
                }
                body.xhs-dark .xhs-style-preview-item .xhs-style-preview-label,
                body.xhs-dark .xhs-style-preview-item .xhs-style-preview-sub {
                    text-shadow: none;
                }
                .xhs-text-cover-mix-pool {
                    display: grid;
                    grid-template-columns: repeat(4, minmax(0, 1fr));
                    gap: 8px;
                    margin-top: 8px;
                }
                .xhs-text-cover-mix-pill {
                    appearance: none;
                    -webkit-appearance: none;
                    border: 1px solid rgba(0,0,0,0.12);
                    border-radius: 999px;
                    padding: 6px 8px;
                    font-size: 12px;
                    font-weight: 700;
                    background: rgba(255,255,255,0.92);
                    color: #333;
                    cursor: pointer;
                    transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
                }
                .xhs-text-cover-mix-pill:hover {
                    transform: translateY(-1px);
                    border-color: rgba(var(--xhs-rgb), 0.45);
                }
                .xhs-text-cover-mix-pill.active {
                    border-color: rgba(var(--xhs-rgb), 0.86);
                    box-shadow: 0 0 0 2px rgba(var(--xhs-rgb), 0.16);
                    color: var(--xhs-c);
                    background: rgba(var(--xhs-rgb), 0.08);
                }
                .xhs-text-cover-mix-pool.is-disabled .xhs-text-cover-mix-pill {
                    opacity: 0.58;
                    filter: saturate(0.35);
                }
                body.xhs-dark .xhs-text-cover-mix-pill {
                    border: 1px solid rgba(255,255,255,0.16);
                    background: rgba(255,255,255,0.05);
                    color: rgba(255,255,255,0.90);
                }
                body.xhs-dark .xhs-text-cover-mix-pill.active {
                    border-color: rgba(var(--xhs-rgb), 0.92);
                    color: #fff;
                    background: rgba(var(--xhs-rgb), 0.28);
                }
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

                .xhs-gradients { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin-top: 8px; }
                .xhs-gradient-item {
                    width: 100%; padding-bottom: 100%; border-radius: 50%;
                    cursor: pointer; border: 2px solid transparent; position: relative;
                    background: linear-gradient(180deg, var(--gt, #33CCFF), var(--gb, #0066CC));
                }
                .xhs-gradient-item.active { border-color: #333; transform: scale(1.1); }
                body.xhs-dark .xhs-gradient-item.active { border-color: rgba(255,255,255,0.75); }
                
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
            // 深色主题下尽量对齐 Discourse 自身配色，避免“站点已是深色但脚本仍按浅色渲染”导致观感割裂
            const discourseVars = {
                secondary: Utils.getCssVar('--secondary'),
                secondaryHigh: Utils.getCssVar('--secondary-high'),
                secondaryVeryHigh: Utils.getCssVar('--secondary-very-high'),
                primary: Utils.getCssVar('--primary'),
                primaryMedium: Utils.getCssVar('--primary-medium')
            };
            const xhsBg = isDark ? (discourseVars.secondary || '#1a1a1a') : '#f4f6f8';
            const xhsCardBg = isDark ? (discourseVars.secondaryVeryHigh || discourseVars.secondaryHigh || '#2d2d2d') : '#fff';
            const xhsText = isDark ? (discourseVars.primary || '#eee') : '#333';
            const xhsTextSub = isDark ? (discourseVars.primaryMedium || '#aaa') : '#666';
            const colsDesktop = cfg.columnCount;
            const cols1400 = Math.min(colsDesktop, 4);
            const cols1100 = Math.min(colsDesktop, 3);
            const cols800 = Math.min(colsDesktop, 2);
            const pillScale = Number(cfg.pillScale) || 1.20;
            const pillOpacity = Math.min(1, Math.max(0.2, Number(cfg.pillOpacity) || 1));
            const gridCoverAR = Number(cfg.gridCardAspectRatio) || 2.0;
            const topicCardsBodyPaddingLeft = Number(cfg.topicReplyCardsBodyPaddingLeft);
            const topicCardsBodyPaddingLeftPx = Math.min(80, Math.max(0, Number.isFinite(topicCardsBodyPaddingLeft) ? topicCardsBodyPaddingLeft : 14));
             
            document.body.classList.toggle('xhs-dark', isDark);

            const css = `
                :root {
                    --xhs-c: ${c};
                    --xhs-rgb: ${rgb};
                    --xhs-bg: ${xhsBg};
                    --xhs-card-bg: ${xhsCardBg};
                    --xhs-text: ${xhsText};
                    --xhs-text-sub: ${xhsTextSub};
                    --xhs-cols: ${colsDesktop};
                    --xhs-pill-scale: ${pillScale};
                    --xhs-pill-alpha: ${pillOpacity};
                    --xhs-grid-cover-ar: ${gridCoverAR};
                }

                body.xhs-on { background: var(--xhs-bg) !important; }
                
                /* 隐藏原生列表（仅在 xhs-grid 真正就绪后才隐藏，避免 SPA 回退/异常导致空白页） */
                body.xhs-on.xhs-active .topic-list,
                body.xhs-on.xhs-active .topic-list-header { display: none !important; }
                
                /* 瀑布流容器 */
                .xhs-grid {
                    /* v4.12：不再使用 CSS columns（会在无限下拉/图片异步加载时触发重排，造成闪烁与“整体重新分列”） */
                    display: flex;
                    align-items: flex-start;
                    gap: 16px;
                    padding: 16px 0;
                    max-width: 1400px;
                    margin: 0 auto;
                    transition: padding-top 0.20s ease;
                }
                body.xhs-on.xhs-active.xhs-has-list-notice .xhs-grid {
                    padding-top: calc(16px + var(--xhs-list-notice-offset, 0px));
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
                    box-shadow: ${isDark ? '0 6px 22px rgba(0,0,0,0.40)' : '0 2px 8px rgba(0,0,0,0.04)'};
                    border: 1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'};
                    overflow: hidden; position: relative;
                    transition: transform 0.2s, box-shadow 0.2s;
                    display: flex; flex-direction: column;
                }
                .xhs-card:hover { transform: translateY(-4px); box-shadow: ${isDark ? '0 10px 30px rgba(0,0,0,0.55)' : '0 8px 20px rgba(0,0,0,0.10)'}; z-index: 2; }
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
                .xhs-cover-toggle {
                    position: absolute;
                    left: 10px;
                    bottom: 10px;
                    z-index: 4;
                    border: 1px solid rgba(0,0,0,0.10);
                    border-radius: 999px;
                    height: 24px;
                    width: 24px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    user-select: none;
                    background: rgba(255,255,255,0.78);
                    color: rgba(0,0,0,0.72);
                    font-size: 13px;
                    font-weight: 700;
                    padding: 0;
                    line-height: 1;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.16);
                    backdrop-filter: blur(6px);
                    -webkit-backdrop-filter: blur(6px);
                    opacity: 0;
                    transform: translateY(6px);
                    pointer-events: none;
                    transition: opacity 0.16s ease, transform 0.16s ease, background 0.16s ease, color 0.16s ease, border-color 0.16s ease;
                }
                .xhs-cover-toggle-menu {
                    position: absolute;
                    left: 10px;
                    bottom: 34px;
                    z-index: 4;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    padding: 4px;
                    border: 1px solid rgba(0,0,0,0.10);
                    border-radius: 999px;
                    background: rgba(255,255,255,0.76);
                    box-shadow: 0 4px 12px rgba(0,0,0,0.18);
                    backdrop-filter: blur(6px);
                    -webkit-backdrop-filter: blur(6px);
                    opacity: 0;
                    transform: translateY(6px);
                    pointer-events: none;
                    transition: opacity 0.16s ease, transform 0.16s ease;
                }
                .xhs-cover-toggle-menu::after {
                    content: '';
                    position: absolute;
                    left: 0;
                    right: 0;
                    bottom: -8px;
                    height: 8px;
                }
                .xhs-cover-toggle-item {
                    border: 1px solid rgba(0,0,0,0.10);
                    border-radius: 999px;
                    min-width: 24px;
                    height: 24px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    user-select: none;
                    background: rgba(255,255,255,0.86);
                    color: rgba(0,0,0,0.72);
                    font-size: 10px;
                    font-weight: 800;
                    padding: 0 6px;
                    line-height: 1;
                    transition: background 0.16s ease, color 0.16s ease, border-color 0.16s ease, filter 0.16s ease;
                }
                .xhs-card:hover .xhs-cover-toggle,
                .xhs-card:focus-within .xhs-cover-toggle,
                .xhs-cover-toggle:hover + .xhs-cover-toggle-menu,
                .xhs-cover-toggle:focus + .xhs-cover-toggle-menu,
                .xhs-cover-toggle-menu:hover,
                .xhs-cover-toggle-menu:focus-within,
                .xhs-card.xhs-cover-menu-open .xhs-cover-toggle-menu {
                    opacity: 1;
                    transform: translateY(0);
                }
                .xhs-card:hover .xhs-cover-toggle,
                .xhs-card:focus-within .xhs-cover-toggle {
                    pointer-events: auto;
                }
                .xhs-cover-toggle:hover + .xhs-cover-toggle-menu,
                .xhs-cover-toggle:focus + .xhs-cover-toggle-menu,
                .xhs-cover-toggle-menu:hover,
                .xhs-cover-toggle-menu:focus-within,
                .xhs-card.xhs-cover-menu-open .xhs-cover-toggle-menu {
                    pointer-events: auto;
                }
                body.xhs-dark .xhs-cover-toggle {
                    background: rgba(18,20,24,0.62);
                    color: rgba(255,255,255,0.88);
                    border: 1px solid rgba(255,255,255,0.18);
                }
                body.xhs-dark .xhs-cover-toggle-menu {
                    background: rgba(18,20,24,0.62);
                    border: 1px solid rgba(255,255,255,0.18);
                }
                body.xhs-dark .xhs-cover-toggle-item {
                    background: rgba(35,38,45,0.78);
                    color: rgba(255,255,255,0.90);
                    border: 1px solid rgba(255,255,255,0.16);
                }
                .xhs-cover-toggle:hover {
                    border-color: rgba(var(--xhs-rgb), 0.48);
                    color: var(--xhs-c);
                    background: rgba(255,255,255,0.92);
                }
                .xhs-cover-toggle-item:hover {
                    border-color: rgba(var(--xhs-rgb), 0.48);
                    color: var(--xhs-c);
                    background: rgba(255,255,255,0.92);
                }
                body.xhs-dark .xhs-cover-toggle:hover {
                    background: rgba(30,33,39,0.82);
                }
                body.xhs-dark .xhs-cover-toggle-item:hover {
                    background: rgba(30,33,39,0.82);
                }
                .xhs-cover-toggle.is-hidden {
                    background: rgba(var(--xhs-rgb), 0.22);
                    color: var(--xhs-c);
                    border-color: rgba(var(--xhs-rgb), 0.40);
                }
                .xhs-cover-toggle-item.is-active {
                    background: rgba(var(--xhs-rgb), 0.22);
                    color: var(--xhs-c);
                    border-color: rgba(var(--xhs-rgb), 0.40);
                }
                .xhs-cover-toggle-item.is-current {
                    box-shadow: inset 0 0 0 1px rgba(var(--xhs-rgb), 0.38);
                }
                .xhs-cover-toggle-item:not(.is-active) {
                    filter: grayscale(0.45) saturate(0.60);
                }
                @media (hover: none), (pointer: coarse) {
                    .xhs-cover-toggle:hover + .xhs-cover-toggle-menu,
                    .xhs-cover-toggle:focus + .xhs-cover-toggle-menu,
                    .xhs-cover-toggle-menu:hover,
                    .xhs-cover-toggle-menu:focus-within {
                        opacity: 0;
                        transform: translateY(6px);
                        pointer-events: none;
                    }
                    .xhs-cover-toggle,
                    .xhs-card.xhs-cover-menu-open .xhs-cover-toggle-menu {
                        opacity: 1;
                        transform: translateY(0);
                        pointer-events: auto;
                    }
                }
                .xhs-real-img {
                    width: 100%; height: auto; display: block; object-fit: cover;
                    opacity: 0; transition: opacity 0.3s;
                }
                .xhs-real-img.loaded { opacity: 1; }

                /* 智能裁剪：仅极端宽/长图时启用（裁到“边界比例”） */
                .xhs-cover.xhs-img-crop {
                    aspect-ratio: var(--xhs-crop-ar, 4 / 3);
                    overflow: hidden;
                }
                @supports not (aspect-ratio: 1 / 1) {
                    .xhs-cover.xhs-img-crop { height: 210px; }
                }
                .xhs-cover.xhs-img-crop .xhs-real-img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    object-position: var(--xhs-img-pos, 50% 50%);
                }
                .xhs-cover.xhs-img-crop.xhs-img-tall { --xhs-img-pos: 50% 0%; }
                .xhs-cover.xhs-img-crop.xhs-img-wide { --xhs-img-pos: 50% 50%; }
                
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
                    opacity: ${isDark ? '0.42' : '0.32'};
                    mix-blend-mode: overlay;
                }
                .xhs-bg.secondary { opacity: ${isDark ? '0.30' : '0.20'}; filter: blur(0.2px); }
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

                .xhs-emoji-icon { font-size: 44px; margin-bottom: 12px; position: relative; z-index: 1; }
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
                .xhs-sticker.xhs-sticker-unread {
                    color: #fff;
                    background: rgba(var(--xhs-rgb), ${isDark ? '0.72' : '0.92'});
                    border: 1px solid rgba(var(--xhs-rgb), ${isDark ? '0.35' : '0.22'});
                    box-shadow: 0 12px 26px rgba(var(--xhs-rgb), ${isDark ? '0.30' : '0.26'});
                    transform: rotate(2deg);
                    letter-spacing: 0.2px;
                }
                .xhs-card.xhs-has-unread {
                    box-shadow: 0 0 0 3px rgba(var(--xhs-rgb), ${isDark ? '0.18' : '0.14'}), 0 10px 28px rgba(0,0,0,0.10);
                }

                /* 文字封面风格（classic/notebook/glass/collage；mix_custom 会在混合池里按帖稳定随机） */
                body[data-xhs-text-cover-style="classic"] .xhs-text-cover {
                    letter-spacing: 0.02em;
                }
                body[data-xhs-text-cover-style="classic"] .xhs-deco.big {
                    opacity: ${isDark ? '0.30' : '0.20'};
                }
                .xhs-text-cover.xhs-text-cover-structured {
                    padding: 30px 16px 14px;
                    min-height: 0;
                    justify-content: center;
                    align-items: flex-start;
                    gap: 10px;
                    background:
                        linear-gradient(180deg, ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.62)'} 0%, rgba(0,0,0,0) 78%),
                        var(--xhs-cover-bg, ${isDark ? '#2c2c2c' : '#fff'});
                    border: 1px solid ${isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)'};
                    border-left: 4px solid rgba(var(--xhs-rgb), ${isDark ? '0.58' : '0.42'});
                    box-shadow: inset 0 -1px 0 ${isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.45)'};
                    text-shadow: none;
                }
                .xhs-text-cover.xhs-text-cover-structured.xhs-text-cover-structured-normal {
                    min-height: 168px;
                }
                .xhs-text-cover.xhs-text-cover-structured.xhs-text-cover-structured-tall {
                    min-height: 216px;
                }
                .xhs-text-cover.xhs-text-cover-structured::before {
                    content: '结构速览';
                    position: absolute;
                    top: 9px;
                    left: 14px;
                    font-size: 11px;
                    font-weight: 800;
                    letter-spacing: 0.08em;
                    color: ${isDark ? 'rgba(255,255,255,0.82)' : 'rgba(0,0,0,0.56)'};
                    pointer-events: none;
                }
                .xhs-text-cover.xhs-text-cover-structured::after {
                    content: '';
                    position: absolute;
                    left: 14px;
                    right: 14px;
                    top: 24px;
                    height: 1px;
                    background: linear-gradient(90deg, rgba(var(--xhs-rgb), ${isDark ? '0.36' : '0.28'}) 0%, rgba(0,0,0,0) 100%);
                    pointer-events: none;
                }
                .xhs-text-cover.xhs-text-cover-structured .xhs-bg.secondary,
                .xhs-text-cover.xhs-text-cover-structured .xhs-deco.band,
                .xhs-text-cover.xhs-text-cover-structured .xhs-deco.tape,
                .xhs-text-cover.xhs-text-cover-structured .xhs-deco.quote {
                    display: none !important;
                }
                .xhs-text-cover.xhs-text-cover-structured .xhs-bg {
                    opacity: ${isDark ? '0.24' : '0.18'};
                    mix-blend-mode: normal;
                }
                .xhs-text-cover.xhs-text-cover-structured .xhs-deco.corner {
                    font-size: 13px;
                    opacity: ${isDark ? '0.28' : '0.20'};
                }
                .xhs-text-cover.xhs-text-cover-structured .xhs-deco.line {
                    font-size: 8px;
                    letter-spacing: 2.4px;
                    opacity: ${isDark ? '0.24' : '0.17'};
                }
                .xhs-text-cover.xhs-text-cover-structured .xhs-deco.big {
                    font-size: 60px;
                    opacity: ${isDark ? '0.15' : '0.09'};
                    mix-blend-mode: normal;
                    transform: translate(-50%, -50%) rotate(0deg);
                }
                .xhs-text-cover.xhs-text-cover-structured .xhs-emoji-icon {
                    font-size: 18px;
                    margin: 0;
                    align-self: flex-start;
                    padding: 1px 6px;
                    border-radius: 999px;
                    background: ${isDark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.62)'};
                    border: 1px solid ${isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.06)'};
                }
                .xhs-text-cover.xhs-text-cover-structured .xhs-text-excerpt {
                    font-size: 17px;
                    line-height: 1.66;
                    font-weight: 680;
                    letter-spacing: 0;
                    -webkit-line-clamp: 5;
                    max-width: 90%;
                    margin-top: 0;
                    padding-left: 2px;
                }
                .xhs-text-cover.xhs-text-cover-structured .xhs-text-excerpt.dropcap::first-letter {
                    float: none;
                    font-size: inherit;
                    line-height: inherit;
                    padding-right: 0;
                    margin-top: 0;
                    opacity: inherit;
                }
                .xhs-text-cover.xhs-text-cover-structured .xhs-sticker {
                    transform: rotate(0deg);
                    right: 8px;
                    bottom: 8px;
                    padding: 2px 7px;
                    font-size: 10px;
                    letter-spacing: 0.2px;
                    box-shadow: none;
                    backdrop-filter: none;
                }
                .xhs-text-cover.xhs-text-cover-structured .xhs-hl {
                    margin: 0 1px;
                    padding: 0 1px;
                    border-radius: 2px;
                }
                .xhs-text-cover.xhs-text-cover-structured .xhs-ul,
                .xhs-text-cover.xhs-text-cover-structured .xhs-wave {
                    text-decoration-thickness: 1.5px;
                    text-underline-offset: 2px;
                }

                .xhs-text-cover.xhs-text-cover-notebook {
                    padding: 22px 18px 16px;
                    min-height: 0;
                    justify-content: center;
                    align-items: center;
                    gap: 10px;
                    text-align: left;
                    background-color: ${isDark ? '#1d2430' : '#f7f9fc'};
                    background-image:
                        linear-gradient(${isDark ? 'rgba(255,255,255,0.07)' : 'rgba(130,142,160,0.22)'} 1px, transparent 1px),
                        linear-gradient(90deg, ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(130,142,160,0.20)'} 1px, transparent 1px),
                        linear-gradient(180deg, ${isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.52)'} 0%, rgba(0,0,0,0) 68%);
                    background-size: 20px 20px, 20px 20px, 100% 100%;
                    border: 1px solid ${isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.08)'};
                    border-left: 2px solid rgba(var(--xhs-rgb), ${isDark ? '0.42' : '0.34'});
                    box-shadow: inset 0 0 0 1px ${isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.85)'};
                    text-shadow: none;
                }
                .xhs-text-cover.xhs-text-cover-notebook.xhs-text-cover-notebook-normal { min-height: 184px; }
                .xhs-text-cover.xhs-text-cover-notebook.xhs-text-cover-notebook-tall { min-height: 232px; }
                .xhs-text-cover.xhs-text-cover-notebook::before,
                .xhs-text-cover.xhs-text-cover-notebook::after,
                .xhs-text-cover.xhs-text-cover-notebook .xhs-bg.secondary,
                .xhs-text-cover.xhs-text-cover-notebook .xhs-deco.band,
                .xhs-text-cover.xhs-text-cover-notebook .xhs-deco.tape,
                .xhs-text-cover.xhs-text-cover-notebook .xhs-deco.quote { display: none !important; }
                .xhs-text-cover.xhs-text-cover-notebook .xhs-bg { opacity: ${isDark ? '0.10' : '0.08'}; mix-blend-mode: normal; }
                .xhs-text-cover.xhs-text-cover-notebook .xhs-deco.corner { font-size: 12px; opacity: ${isDark ? '0.20' : '0.15'}; }
                .xhs-text-cover.xhs-text-cover-notebook .xhs-deco.line { font-size: 8px; letter-spacing: 3px; opacity: ${isDark ? '0.24' : '0.18'}; }
                .xhs-text-cover.xhs-text-cover-notebook .xhs-deco.big { font-size: 56px; opacity: ${isDark ? '0.13' : '0.09'}; mix-blend-mode: normal; transform: translate(-50%, -50%) rotate(-4deg); }
                .xhs-text-cover.xhs-text-cover-notebook .xhs-emoji-icon { font-size: 28px; margin: 0; align-self: flex-end; }
                .xhs-text-cover.xhs-text-cover-notebook .xhs-text-excerpt {
                    font-size: 22px;
                    line-height: 1.52;
                    font-weight: 820;
                    letter-spacing: -0.02em;
                    color: ${isDark ? '#F3F6FA' : '#2D2D2D'};
                    -webkit-line-clamp: 5;
                    margin-top: 0;
                    max-width: 86%;
                    align-self: center;
                }
                .xhs-text-cover.xhs-text-cover-notebook .xhs-text-excerpt.dropcap::first-letter { float: none; font-size: inherit; line-height: inherit; padding-right: 0; margin-top: 0; opacity: inherit; }
                .xhs-text-cover.xhs-text-cover-notebook .xhs-sticker { transform: rotate(0deg); right: 8px; bottom: 8px; padding: 2px 7px; font-size: 10px; letter-spacing: 0.2px; background: ${isDark ? 'rgba(0,0,0,0.32)' : 'rgba(255,255,255,0.72)'}; border: 1px solid ${isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)'}; box-shadow: none; backdrop-filter: none; }
                .xhs-text-cover.xhs-text-cover-notebook .xhs-hl { margin: 0 1px; padding: 0 3px; border-radius: 2px; background: linear-gradient(180deg, rgba(0,0,0,0) 58%, ${isDark ? 'rgba(255,233,95,0.42)' : 'rgba(253,252,71,0.70)'} 58%); box-decoration-break: clone; -webkit-box-decoration-break: clone; }
                .xhs-text-cover.xhs-text-cover-notebook .xhs-wave,
                .xhs-text-cover.xhs-text-cover-notebook .xhs-ul { text-decoration-thickness: 2px; text-underline-offset: 2px; }

                .xhs-text-cover.xhs-text-cover-collage {
                    padding: 26px 14px 14px;
                    min-height: 0;
                    justify-content: center;
                    align-items: center;
                    gap: 10px;
                    text-align: center;
                    background-color: ${isDark ? '#D5B300' : '#FFDE00'};
                    background-image: radial-gradient(${isDark ? 'rgba(0,0,0,0.52)' : 'rgba(0,0,0,0.36)'} 1.4px, transparent 0);
                    background-size: 18px 18px;
                    border: 3px solid ${isDark ? 'rgba(0,0,0,0.82)' : 'rgba(0,0,0,0.88)'};
                    box-shadow: 0 12px 24px rgba(0,0,0,${isDark ? '0.34' : '0.18'});
                    text-shadow: none;
                }
                .xhs-text-cover.xhs-text-cover-collage.xhs-text-cover-collage-normal { min-height: 184px; }
                .xhs-text-cover.xhs-text-cover-collage.xhs-text-cover-collage-tall { min-height: 232px; }
                .xhs-text-cover.xhs-text-cover-collage::before {
                    content: '';
                    position: absolute;
                    top: 9px;
                    left: 50%;
                    transform: translateX(-50%) rotate(-3deg);
                    width: 86px;
                    height: 22px;
                    background: ${isDark ? 'rgba(255,255,255,0.30)' : 'rgba(255,255,255,0.45)'};
                    border-left: 2px dashed rgba(0,0,0,0.14);
                    border-right: 2px dashed rgba(0,0,0,0.14);
                    pointer-events: none;
                }
                .xhs-text-cover.xhs-text-cover-collage::after,
                .xhs-text-cover.xhs-text-cover-collage .xhs-bg.secondary,
                .xhs-text-cover.xhs-text-cover-collage .xhs-deco.band,
                .xhs-text-cover.xhs-text-cover-collage .xhs-deco.quote,
                .xhs-text-cover.xhs-text-cover-collage .xhs-deco.line,
                .xhs-text-cover.xhs-text-cover-collage .xhs-deco.tape { display: none !important; }
                .xhs-text-cover.xhs-text-cover-collage .xhs-bg { opacity: ${isDark ? '0.05' : '0.03'}; mix-blend-mode: multiply; }
                .xhs-text-cover.xhs-text-cover-collage .xhs-deco.corner { font-size: 18px; opacity: ${isDark ? '0.55' : '0.38'}; color: rgba(0,0,0,0.72); }
                .xhs-text-cover.xhs-text-cover-collage .xhs-deco.big { font-size: 54px; opacity: ${isDark ? '0.22' : '0.14'}; transform: translate(-50%, -50%) rotate(8deg); mix-blend-mode: multiply; color: rgba(0,0,0,0.62); }
                .xhs-text-cover.xhs-text-cover-collage .xhs-emoji-icon {
                    font-size: 18px;
                    margin: 10px 0 2px;
                    padding: 0 8px 1px;
                    border-radius: 999px;
                    background: rgba(255,255,255,0.95);
                    border: 2px solid rgba(0,0,0,0.86);
                    box-shadow: 3px 3px 0 rgba(0,0,0,0.86);
                    transform: rotate(-7deg);
                    align-self: flex-start;
                }
                .xhs-text-cover.xhs-text-cover-collage .xhs-text-excerpt {
                    font-size: 24px;
                    line-height: 1.34;
                    font-weight: 900;
                    letter-spacing: -0.01em;
                    color: ${isDark ? '#121212' : '#141414'};
                    -webkit-line-clamp: 4;
                    max-width: 90%;
                    margin-top: 0;
                    background: rgba(255,255,255,0.96);
                    border: 3px solid rgba(0,0,0,0.90);
                    box-shadow: 7px 7px 0 rgba(0,0,0,0.88);
                    padding: 11px 12px 10px;
                    transform: rotate(-2.4deg);
                }
                .xhs-text-cover.xhs-text-cover-collage .xhs-text-excerpt.dropcap::first-letter { float: none; font-size: inherit; line-height: inherit; padding-right: 0; margin-top: 0; opacity: inherit; }
                .xhs-text-cover.xhs-text-cover-collage .xhs-sticker {
                    transform: rotate(5deg);
                    right: 10px;
                    bottom: 10px;
                    padding: 2px 9px;
                    font-size: 11px;
                    color: #fff;
                    background: #FF4757;
                    border: 2px solid rgba(0,0,0,0.88);
                    box-shadow: 4px 4px 0 rgba(0,0,0,0.88);
                    border-radius: 4px;
                    backdrop-filter: none;
                }
                .xhs-text-cover.xhs-text-cover-collage .xhs-hl {
                    margin: 0 1px;
                    padding: 0 2px;
                    border-radius: 2px;
                    background: rgba(255, 222, 0, 0.92);
                }
                .xhs-text-cover.xhs-text-cover-collage .xhs-ul,
                .xhs-text-cover.xhs-text-cover-collage .xhs-wave {
                    text-decoration-color: rgba(0,0,0,0.68);
                    text-underline-offset: 2px;
                }
                .xhs-text-cover.xhs-text-cover-collage .xhs-dot::after { bottom: -7px; color: rgba(0,0,0,0.72); }

                .xhs-text-cover.xhs-text-cover-poster {
                    padding: 22px 16px 12px;
                    min-height: 0;
                    justify-content: center;
                    align-items: center;
                    gap: 10px;
                    text-align: center;
                    background:
                        radial-gradient(circle at 86% 14%, rgba(var(--xhs-rgb), ${isDark ? '0.22' : '0.16'}) 0%, rgba(0,0,0,0) 54%),
                        linear-gradient(150deg, ${isDark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.68)'} 0%, rgba(0,0,0,0) 64%),
                        var(--xhs-cover-bg, ${isDark ? '#232323' : '#fff'});
                    border: 1px solid ${isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.08)'};
                    box-shadow:
                        inset 0 0 0 1px ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.85)'},
                        0 8px 18px rgba(0,0,0,${isDark ? '0.26' : '0.12'});
                    text-shadow: none;
                }
                .xhs-text-cover.xhs-text-cover-poster.xhs-text-cover-poster-normal { min-height: 184px; }
                .xhs-text-cover.xhs-text-cover-poster.xhs-text-cover-poster-tall { min-height: 232px; }
                .xhs-text-cover.xhs-text-cover-poster::before { content: ''; position: absolute; inset: 10px; border: 1px solid ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.10)'}; border-radius: 10px; pointer-events: none; }
                .xhs-text-cover.xhs-text-cover-poster::after { content: ''; position: absolute; inset: -24% -20% auto auto; width: 170px; height: 170px; border-radius: 50%; background: radial-gradient(circle, rgba(var(--xhs-rgb), ${isDark ? '0.40' : '0.28'}) 0%, rgba(0,0,0,0) 72%); pointer-events: none; }
                .xhs-text-cover.xhs-text-cover-poster .xhs-bg.secondary,
                .xhs-text-cover.xhs-text-cover-poster .xhs-deco.quote,
                .xhs-text-cover.xhs-text-cover-poster .xhs-deco.band,
                .xhs-text-cover.xhs-text-cover-poster .xhs-deco.tape { display: none !important; }
                .xhs-text-cover.xhs-text-cover-poster .xhs-bg { opacity: ${isDark ? '0.16' : '0.11'}; mix-blend-mode: normal; }
                .xhs-text-cover.xhs-text-cover-poster .xhs-deco.corner { font-size: 12px; opacity: ${isDark ? '0.18' : '0.14'}; }
                .xhs-text-cover.xhs-text-cover-poster .xhs-deco.line { display: none !important; }
                .xhs-text-cover.xhs-text-cover-poster .xhs-deco.big { font-size: 72px; opacity: ${isDark ? '0.14' : '0.10'}; mix-blend-mode: normal; transform: translate(-50%, -50%) rotate(-6deg); }
                .xhs-text-cover.xhs-text-cover-poster .xhs-emoji-icon { margin: 0; font-size: 24px; padding: 0; background: none; border: none; align-self: center; }
                .xhs-text-cover.xhs-text-cover-poster .xhs-text-excerpt {
                    font-size: 19px;
                    line-height: 1.44;
                    font-weight: 840;
                    letter-spacing: 0.01em;
                    -webkit-line-clamp: 5;
                    margin-top: 0;
                    text-wrap: balance;
                    max-width: 88%;
                    align-self: center;
                }
                .xhs-text-cover.xhs-text-cover-poster .xhs-text-excerpt.dropcap::first-letter { float: none; font-size: inherit; line-height: inherit; padding-right: 0; margin-top: 0; opacity: inherit; }
                .xhs-text-cover.xhs-text-cover-poster .xhs-sticker { transform: rotate(0deg); right: 9px; bottom: 9px; padding: 2px 8px; font-size: 10px; letter-spacing: 0.25px; background: ${isDark ? 'rgba(0,0,0,0.36)' : 'rgba(255,255,255,0.74)'}; border: 1px solid ${isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)'}; box-shadow: none; backdrop-filter: blur(2px); }
                .xhs-text-cover.xhs-text-cover-poster .xhs-hl { background: rgba(var(--xhs-rgb), ${isDark ? '0.34' : '0.24'}); border-radius: 4px; margin: 0 1px; padding: 0 3px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
                .xhs-text-cover.xhs-text-cover-poster .xhs-ul,
                .xhs-text-cover.xhs-text-cover-poster .xhs-wave { text-decoration: none; border-bottom: 2px solid rgba(var(--xhs-rgb), ${isDark ? '0.56' : '0.44'}); }
                .xhs-text-cover.xhs-text-cover-poster .xhs-dot::after { display: none; }

                .xhs-text-cover.xhs-text-cover-glass {
                    padding: 20px 16px 12px;
                    min-height: 0;
                    justify-content: center;
                    align-items: center;
                    gap: 10px;
                    text-align: center;
                    background:
                        linear-gradient(160deg, ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.72)'} 0%, rgba(255,255,255,0.08) 44%, rgba(0,0,0,0) 100%),
                        radial-gradient(circle at 18% 12%, rgba(var(--xhs-rgb), ${isDark ? '0.22' : '0.16'}) 0%, rgba(0,0,0,0) 45%),
                        var(--xhs-cover-bg, ${isDark ? '#232833' : '#dfe9f6'});
                    border: 1px solid ${isDark ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.80)'};
                    box-shadow: 0 12px 28px rgba(0,0,0,${isDark ? '0.28' : '0.14'});
                    backdrop-filter: blur(7px) saturate(120%);
                    -webkit-backdrop-filter: blur(7px) saturate(120%);
                }
                .xhs-text-cover.xhs-text-cover-glass::before {
                    content: '';
                    position: absolute;
                    inset: 14px 11%;
                    border-radius: 12px;
                    background: ${isDark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.34)'};
                    border: 1px solid ${isDark ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.62)'};
                    box-shadow: inset 0 1px 0 rgba(255,255,255,0.35);
                    pointer-events: none;
                }
                .xhs-text-cover.xhs-text-cover-glass.xhs-text-cover-glass-normal { min-height: 176px; }
                .xhs-text-cover.xhs-text-cover-glass.xhs-text-cover-glass-tall { min-height: 224px; }
                .xhs-text-cover.xhs-text-cover-glass::after,
                .xhs-text-cover.xhs-text-cover-glass .xhs-bg.secondary,
                .xhs-text-cover.xhs-text-cover-glass .xhs-deco.tape,
                .xhs-text-cover.xhs-text-cover-glass .xhs-deco.line { display: none !important; }
                .xhs-text-cover.xhs-text-cover-glass .xhs-bg { opacity: ${isDark ? '0.18' : '0.12'}; mix-blend-mode: normal; }
                .xhs-text-cover.xhs-text-cover-glass .xhs-deco.corner { font-size: 12px; opacity: ${isDark ? '0.20' : '0.14'}; }
                .xhs-text-cover.xhs-text-cover-glass .xhs-deco.big { font-size: 64px; opacity: ${isDark ? '0.16' : '0.11'}; transform: translate(-50%, -50%) rotate(-8deg); }
                .xhs-text-cover.xhs-text-cover-glass .xhs-emoji-icon { font-size: 22px; margin: 0; padding: 1px 8px; border-radius: 999px; background: ${isDark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.68)'}; border: 1px solid ${isDark ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.90)'}; align-self: center; z-index: 1; }
                .xhs-text-cover.xhs-text-cover-glass .xhs-text-excerpt { font-size: 18px; line-height: 1.58; font-weight: 700; -webkit-line-clamp: 5; margin-top: 0; max-width: 76%; align-self: center; z-index: 1; text-shadow: 0 1px 2px rgba(0,0,0,${isDark ? '0.20' : '0.06'}); }
                .xhs-text-cover.xhs-text-cover-glass .xhs-text-excerpt.dropcap::first-letter { float: none; font-size: inherit; line-height: inherit; padding-right: 0; margin-top: 0; opacity: inherit; }
                .xhs-text-cover.xhs-text-cover-glass .xhs-sticker { transform: rotate(0deg); right: 8px; bottom: 8px; font-size: 10px; padding: 2px 7px; box-shadow: none; backdrop-filter: blur(4px); }

                .xhs-text-cover.xhs-text-cover-magazine {
                    padding: 24px 16px 14px;
                    min-height: 0;
                    justify-content: center;
                    align-items: center;
                    gap: 10px;
                    text-align: center;
                    background:
                        linear-gradient(180deg, rgba(var(--xhs-rgb), ${isDark ? '0.22' : '0.16'}) 0 14px, rgba(0,0,0,0) 14px),
                        linear-gradient(160deg, ${isDark ? 'rgba(0,0,0,0.20)' : 'rgba(255,255,255,0.55)'} 0%, rgba(0,0,0,0) 55%),
                        var(--xhs-cover-bg, ${isDark ? '#1f2556' : '#2f54eb'});
                    border: 1px solid ${isDark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.34)'};
                    box-shadow: 0 10px 24px rgba(0,0,0,${isDark ? '0.28' : '0.12'});
                    text-shadow: none;
                }
                .xhs-text-cover.xhs-text-cover-magazine::before {
                    content: 'COVER STORY';
                    position: absolute;
                    top: 8px;
                    left: 12px;
                    font-size: 9px;
                    letter-spacing: 0.18em;
                    font-weight: 800;
                    color: rgba(255,255,255,0.86);
                    pointer-events: none;
                }
                .xhs-text-cover.xhs-text-cover-magazine::after {
                    content: '';
                    position: absolute;
                    left: 12px;
                    right: 12px;
                    top: 22px;
                    height: 1px;
                    background: rgba(255,255,255,0.35);
                    pointer-events: none;
                }
                .xhs-text-cover.xhs-text-cover-magazine.xhs-text-cover-magazine-normal { min-height: 186px; }
                .xhs-text-cover.xhs-text-cover-magazine.xhs-text-cover-magazine-tall { min-height: 228px; }
                .xhs-text-cover.xhs-text-cover-magazine .xhs-bg.secondary,
                .xhs-text-cover.xhs-text-cover-magazine .xhs-deco.quote,
                .xhs-text-cover.xhs-text-cover-magazine .xhs-deco.tape,
                .xhs-text-cover.xhs-text-cover-magazine .xhs-deco.corner { display: none !important; }
                .xhs-text-cover.xhs-text-cover-magazine .xhs-bg { opacity: ${isDark ? '0.12' : '0.08'}; mix-blend-mode: normal; }
                .xhs-text-cover.xhs-text-cover-magazine .xhs-deco.band { opacity: ${isDark ? '0.20' : '0.14'}; }
                .xhs-text-cover.xhs-text-cover-magazine .xhs-deco.line { font-size: 8px; letter-spacing: 4px; opacity: ${isDark ? '0.30' : '0.24'}; }
                .xhs-text-cover.xhs-text-cover-magazine .xhs-deco.big { font-size: 70px; opacity: ${isDark ? '0.16' : '0.12'}; transform: translate(-50%, -50%) rotate(-10deg); }
                .xhs-text-cover.xhs-text-cover-magazine .xhs-emoji-icon { margin: 0; font-size: 18px; padding: 1px 6px; border-radius: 4px; background: ${isDark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.80)'}; border: 1px solid ${isDark ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.95)'}; align-self: flex-start; }
                .xhs-text-cover.xhs-text-cover-magazine .xhs-text-excerpt {
                    font-size: 24px;
                    line-height: 1.24;
                    font-weight: 880;
                    letter-spacing: 0.01em;
                    -webkit-line-clamp: 5;
                    margin-top: 4px;
                    max-width: 88%;
                    color: ${isDark ? '#1f2556' : '#2f54eb'};
                    background: rgba(255,255,255,0.90);
                    border: 1px solid rgba(255,255,255,0.96);
                    border-radius: 6px;
                    padding: 10px 10px 8px;
                    align-self: center;
                    text-align: left;
                    text-shadow: none;
                    box-shadow: 0 8px 18px rgba(0,0,0,${isDark ? '0.32' : '0.18'});
                }
                .xhs-text-cover.xhs-text-cover-magazine .xhs-text-excerpt.dropcap::first-letter { float: none; font-size: inherit; line-height: inherit; padding-right: 0; margin-top: 0; opacity: inherit; }
                .xhs-text-cover.xhs-text-cover-magazine .xhs-sticker { transform: rotate(0deg); right: 8px; bottom: 8px; font-size: 10px; padding: 2px 8px; letter-spacing: 0.22px; box-shadow: none; backdrop-filter: none; }
                .xhs-text-cover.xhs-text-cover-magazine .xhs-hl { background: rgba(255,255,255,${isDark ? '0.28' : '0.22'}); color: inherit; border-radius: 3px; margin: 0 1px; padding: 0 2px; }

                .xhs-text-cover.xhs-text-cover-aura {
                    padding: 20px 16px 12px;
                    min-height: 0;
                    justify-content: center;
                    align-items: center;
                    text-align: center;
                    gap: 10px;
                    background-color: ${isDark ? '#27202f' : '#ffecd2'};
                    background-image:
                        radial-gradient(at 0% 0%, ${isDark ? 'rgba(82,70,110,0.75)' : 'rgba(50,20,80,0.42)'} 0, transparent 52%),
                        radial-gradient(at 70% 12%, ${isDark ? 'rgba(58,88,150,0.62)' : 'rgba(59,79,154,0.35)'} 0, transparent 56%),
                        radial-gradient(at 100% 0%, ${isDark ? 'rgba(138,52,106,0.60)' : 'rgba(146,54,112,0.30)'} 0, transparent 54%),
                        linear-gradient(180deg, rgba(255,255,255,${isDark ? '0.04' : '0.26'}) 0%, rgba(0,0,0,0) 70%);
                    border: 1px solid ${isDark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.46)'};
                    box-shadow: 0 10px 22px rgba(0,0,0,${isDark ? '0.28' : '0.12'});
                }
                .xhs-text-cover.xhs-text-cover-aura::before {
                    content: '';
                    position: absolute;
                    inset: 16px 10%;
                    border-radius: 12px;
                    background: ${isDark ? 'rgba(15,16,24,0.46)' : 'rgba(255,255,255,0.42)'};
                    border: 1px solid ${isDark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.62)'};
                    backdrop-filter: blur(2px);
                    pointer-events: none;
                }
                .xhs-text-cover.xhs-text-cover-aura::after {
                    display: none !important;
                }
                .xhs-text-cover.xhs-text-cover-aura.xhs-text-cover-aura-normal { min-height: 176px; }
                .xhs-text-cover.xhs-text-cover-aura.xhs-text-cover-aura-tall { min-height: 224px; }
                .xhs-text-cover.xhs-text-cover-aura .xhs-bg.secondary,
                .xhs-text-cover.xhs-text-cover-aura .xhs-deco.band,
                .xhs-text-cover.xhs-text-cover-aura .xhs-deco.tape,
                .xhs-text-cover.xhs-text-cover-aura .xhs-deco.line { display: none !important; }
                .xhs-text-cover.xhs-text-cover-aura .xhs-bg { opacity: ${isDark ? '0.10' : '0.07'}; mix-blend-mode: normal; }
                .xhs-text-cover.xhs-text-cover-aura .xhs-deco.corner { font-size: 12px; opacity: ${isDark ? '0.18' : '0.14'}; }
                .xhs-text-cover.xhs-text-cover-aura .xhs-deco.quote { font-size: 40px; opacity: ${isDark ? '0.18' : '0.13'}; }
                .xhs-text-cover.xhs-text-cover-aura .xhs-deco.big { font-size: 66px; opacity: ${isDark ? '0.13' : '0.09'}; transform: translate(-50%, -50%) rotate(0deg); }
                .xhs-text-cover.xhs-text-cover-aura .xhs-emoji-icon { font-size: 22px; margin: 0 0 6px; opacity: 0.92; }
                .xhs-text-cover.xhs-text-cover-aura .xhs-text-excerpt {
                    font-size: 20px;
                    line-height: 1.60;
                    font-weight: 650;
                    letter-spacing: 0.02em;
                    -webkit-line-clamp: 5;
                    color: ${isDark ? '#F7F8FF' : '#ffffff'};
                    font-family: "Songti SC", "SimSun", serif;
                    max-width: 86%;
                    padding: 8px 10px 6px;
                    border-radius: 10px;
                    background: ${isDark ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.12)'};
                    text-shadow: 0 2px 10px rgba(0,0,0,0.40);
                    z-index: 1;
                }
                .xhs-text-cover.xhs-text-cover-aura .xhs-text-excerpt.dropcap::first-letter { float: none; font-size: inherit; line-height: inherit; padding-right: 0; margin-top: 0; opacity: inherit; }
                .xhs-text-cover.xhs-text-cover-aura .xhs-sticker { transform: rotate(0deg); right: 8px; bottom: 8px; font-size: 10px; padding: 2px 8px; box-shadow: none; backdrop-filter: none; }
                .xhs-text-cover.xhs-text-cover-aura .xhs-hl { background: rgba(255,255,255,${isDark ? '0.28' : '0.30'}); border-radius: 3px; margin: 0 1px; padding: 0 3px; }
                
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
                
                .xhs-meta { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 11px; color: var(--xhs-text-sub); min-width: 0; }
                .xhs-user { display: flex; align-items: center; gap: 6px; color: inherit; text-decoration: none; min-width: 0; flex: 1 1 auto; }
                .xhs-user:hover { color: var(--xhs-c); }
                .xhs-avatar { width: 20px; height: 20px; border-radius: 50%; background: #ddd; object-fit: cover;}
                .xhs-user span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .xhs-last-activity { display: none; margin-left: auto; white-space: nowrap; opacity: ${isDark ? '0.90' : '0.85'}; }
                .xhs-last-activity:empty { display: none !important; }
                body[data-xhs-author-display="avatar"] .xhs-user span { display: none !important; }
                body[data-xhs-author-display="name"] .xhs-user img.xhs-avatar { display: none !important; }
                
                .xhs-replies-link { color: inherit; text-decoration: none; }
                .xhs-replies-link:hover { color: var(--xhs-c); }
                
                .xhs-stats { display: flex; gap: 8px; flex: 0 0 auto; white-space: nowrap; }
                .xhs-stat-item { display: flex; align-items: center; gap: 2px; }
                body[data-xhs-meta-layout=\"spacious\"] .xhs-meta { flex-wrap: wrap; justify-content: flex-start; align-items: flex-start; row-gap: 6px; }
                body[data-xhs-meta-layout=\"spacious\"][data-xhs-stat-last-activity=\"1\"] .xhs-last-activity { display: inline-flex; }
                body[data-xhs-meta-layout=\"spacious\"] .xhs-stats { flex-basis: 100%; justify-content: flex-start; width: 100%; }
                body[data-xhs-meta-layout=\"spacious\"][data-xhs-stats-align=\"right\"] .xhs-stats { justify-content: flex-end; }
                body[data-xhs-meta-layout=\"spacious\"][data-xhs-stats-align=\"justify\"] .xhs-stats { justify-content: space-between; }
                body[data-xhs-show-stats="0"] .xhs-stats,
                body[data-xhs-show-stats="0"] .xhs-last-activity { display: none !important; }
                body[data-xhs-stat-likes="0"] .xhs-likes { display: none !important; }
                body[data-xhs-stat-replies="0"] .xhs-replies { display: none !important; }
                body[data-xhs-stat-views="0"] .xhs-views { display: none !important; }

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
                    background: rgba(255,255,255, calc(0.95 * var(--xhs-pill-alpha, 1)));
                    backdrop-filter: blur(4px);
                    color: var(--xhs-c);
                    font-size: calc(10px * var(--xhs-pill-scale, 1));
                    padding: calc(3px * var(--xhs-pill-scale, 1)) calc(8px * var(--xhs-pill-scale, 1));
                    border-radius: 999px;
                    font-weight: 700;
                    box-shadow: 0 2px 6px rgba(0,0,0,0.14);
                }
                .xhs-tag-pill {
                    pointer-events: auto;
                    /* 浅色主题：用更亮的底色，避免封面偏暗（黑图）时 tag pill 看不清 */
                    background: rgba(255,255,255, calc(0.86 * var(--xhs-pill-alpha, 1)));
                    border: 1px solid rgba(0,0,0, calc(0.10 * var(--xhs-pill-alpha, 1)));
                    -webkit-backdrop-filter: blur(4px);
                    backdrop-filter: blur(4px);
                    color: rgba(0,0,0,0.82);
                    font-size: calc(10px * var(--xhs-pill-scale, 1));
                    padding: calc(3px * var(--xhs-pill-scale, 1)) calc(8px * var(--xhs-pill-scale, 1));
                    border-radius: 999px;
                    cursor: pointer;
                    font-weight: 650;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.14);
                }
                body.xhs-dark .xhs-cat-pill {
                    background: rgba(0,0,0, calc(0.68 * var(--xhs-pill-alpha, 1)));
                    border: 1px solid rgba(255,255,255, calc(0.12 * var(--xhs-pill-alpha, 1)));
                    color: #fff;
                }
                body.xhs-dark .xhs-tag-pill {
                    /* 深色主题下：用更深的底色保证在“白色/浅色封面”上也能看清 */
                    background: rgba(0,0,0, calc(0.52 * var(--xhs-pill-alpha, 1)));
                    border: 1px solid rgba(255,255,255, calc(0.14 * var(--xhs-pill-alpha, 1)));
                    color: rgba(255,255,255,0.92);
                    text-shadow: 0 1px 2px rgba(0,0,0,0.65);
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
                .xhs-cover.has-img .xhs-text-cover { display: none; }
                .xhs-cover.has-img::after {
                    content: '';
                    position: absolute;
                    inset: 0;
                    pointer-events: none;
                    background: linear-gradient(180deg, rgba(0,0,0,0.00) 52%, rgba(0,0,0,0.22) 100%);
                }
                .xhs-card.xhs-cover-hidden .xhs-cover img.xhs-real-img { display: none !important; }
                .xhs-card.xhs-cover-hidden .xhs-cover .xhs-text-cover { display: flex !important; }
                .xhs-card.xhs-cover-hidden .xhs-cover::after { display: none !important; }
                .xhs-card.xhs-cover-hidden .xhs-cover {
                    aspect-ratio: auto !important;
                    height: auto !important;
                }
                .xhs-card.xhs-cover-hidden .xhs-cover.xhs-img-crop {
                    aspect-ratio: auto !important;
                    height: auto !important;
                }
                .xhs-grid.grid-mode .xhs-card.xhs-cover-hidden .xhs-cover .xhs-text-cover {
                    height: auto;
                    min-height: 168px;
                }

                /* grid-mode（非错落布局）：固定封面比例，减少“行高由最长卡片决定”造成的大段留空 */
                .xhs-grid.grid-mode .xhs-cover {
                    aspect-ratio: var(--xhs-grid-cover-ar, 4 / 3);
                    overflow: hidden;
                }
                @supports not (aspect-ratio: 1 / 1) {
                    .xhs-grid.grid-mode .xhs-cover { height: 210px; }
                }
                .xhs-grid.grid-mode .xhs-cover .xhs-real-img {
                    height: 100%;
                    object-position: var(--xhs-img-pos, 50% 50%);
                }
                .xhs-grid.grid-mode .xhs-cover .xhs-text-cover {
                    height: 100%;
                    min-height: 0;
                }
                .xhs-grid.grid-mode .xhs-title { min-height: 2.8em; }

                /* 卡片更“立体”一点 */
                .xhs-card {
                    border-radius: 14px;
                    box-shadow: 0 6px 22px rgba(0,0,0,0.06);
                }
                .xhs-card:hover {
                    box-shadow: 0 10px 28px rgba(0,0,0,0.10);
                }

                /* 统计信息开关（避免重建 DOM） */
                body[data-xhs-show-stats="0"] .xhs-stats,
                body[data-xhs-show-stats="0"] .xhs-last-activity { display: none !important; }
                
                /* 帖子页：回复卡片化（仅在 /t/... 生效） */
                body.xhs-topic-cards .topic-post {
                    box-sizing: border-box;
                    width: min(980px, calc(100% - 16px));
                    margin: 14px auto;
                    background: var(--xhs-card-bg);
                    border: 1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'};
                    border-radius: 16px;
                    box-shadow: ${isDark ? '0 10px 34px rgba(0,0,0,0.45)' : '0 8px 22px rgba(0,0,0,0.07)'};
                    overflow: hidden;
                }
                /* Discourse 的 sticky avatar 在卡片化时会导致“头像列”相对正文上移/下移，视觉上难以与 meta 对齐：卡片化下禁用 sticky */
                body.xhs-topic-cards .topic-post .post__row { align-items: flex-start; }
                body.xhs-topic-cards .topic-post .topic-avatar { padding-left: 14px; position: static !important; top: auto !important; }
                body.xhs-topic-cards .topic-post .topic-body { padding-top: 0 !important; padding-left: ${topicCardsBodyPaddingLeftPx}px; padding-right: 14px; }
                body.xhs-topic-cards .topic-post .topic-meta-data { padding-top: 10px; }

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
        listObserver: null,
        listObserverTarget: null,
        pendingNewRowsByTid: null,
        pendingNewRowsTimer: null,
        bodyObserver: null,
        renderedTids: null,
        
        // 请求速率限制（默认开启；遇到 429 自动放慢）
        rateLimit: {
            enabled: true,
            baseInterval: 350,  // 来自配置：最小请求间隔（ms）
            interval: 350,      // 当前动态间隔（ms）
            maxInterval: 2500,  // 自动放慢上限
            cooldownUntil: 0,   // 冷却到某时间点（ms 时间戳）
            cooldownMs: 5000,   // 冷却时长（ms，和 Retry-After 取较大值）
            autoTune: true,
            lastReqAt: 0,
            last429At: 0,
            tuned: false
        },
        rateLimitLock: Promise.resolve(),

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
        forceReorderOnNextRender: false,
        coverRevalidateMs: 8 * 60 * 60 * 1000, // 主楼图懒校验周期（仅可见卡片触发）
        coverRevalidatedInSession: new Set(),
        keywordRegexCache: { key: '', regex: null },

        getListJsonUrl() {
            const path = window.location.pathname;
            const search = window.location.search || '';

            if (path === '/') return `/latest.json${search}`;
            if (path.startsWith('/latest')) return `/latest.json${search}`;
            if (path.startsWith('/top')) return `${path}.json${search}`;
            if (path.startsWith('/hot')) return `${path}.json${search}`;
            if (path.startsWith('/categories')) return `/categories.json${search}`;
            if (path.startsWith('/tag/')) return `${path}.json${search}`;
            if (path.startsWith('/c/')) return `${path}.json${search}`;
            return null;
        },

        normalizeImageUrl(url) {
            const raw = String(url || '').trim();
            if (!raw) return '';
            try { return new URL(raw, window.location.origin).href; } catch { return raw; }
        },

        toPositiveInt(value) {
            const n = parseInt(value, 10);
            return Number.isFinite(n) && n > 0 ? n : null;
        },

        toPositiveNumber(value) {
            const n = Number(value);
            return Number.isFinite(n) && n > 0 ? n : null;
        },

        extractImageShape(data) {
            const d = data || {};
            const imgW = this.toPositiveInt(d.imgW ?? d.image_width ?? d.imageWidth);
            const imgH = this.toPositiveInt(d.imgH ?? d.image_height ?? d.imageHeight);
            let imgAR = this.toPositiveNumber(d.imgAR ?? d.image_ratio ?? d.imageRatio);
            if (!imgAR && imgW && imgH) imgAR = imgW / imgH;
            return {
                imgW: imgW || null,
                imgH: imgH || null,
                imgAR: imgAR || null
            };
        },

        applyImageShapeToImg(img, data) {
            if (!img) return;
            const shape = this.extractImageShape(data);
            if (shape.imgW && shape.imgH) {
                img.setAttribute('width', String(shape.imgW));
                img.setAttribute('height', String(shape.imgH));
            } else {
                img.removeAttribute('width');
                img.removeAttribute('height');
            }
            if (shape.imgAR && !(shape.imgW && shape.imgH)) {
                img.style.setProperty('aspect-ratio', String(shape.imgAR));
            } else {
                img.style.removeProperty('aspect-ratio');
            }
        },

        shouldForceRefreshCover(tid, cached) {
            const key = String(tid || '').trim();
            if (!key) return false;
            if (!cached || !cached.img) return false;
            if (cached.needsImage) return true;
            if (cached.origin !== 'topic') return false;
            if (this.coverRevalidatedInSession.has(key)) return false;

            const cfg = Config.get();
            if (!cfg.cacheEnabled) return false;
            this.loadPersistentCache();
            const entry = this.persistentCache?.get?.(key);
            const ts = typeof entry?.ts === 'number' ? entry.ts : 0;
            if (!ts) return false;
            if ((Date.now() - ts) < this.coverRevalidateMs) return false;

            this.coverRevalidatedInSession.add(key);
            return true;
        },

        ensureListMetaLoaded() {
            const url = this.getListJsonUrl();
            if (!url) return;
            if (this.listMetaUrl === url && this.listMetaPromise) return;

            this.listMetaUrl = url;
            this.listTopicMeta = new Map();
            this.listMetaPromise = (async () => {
                try {
                    const res = await this._rateLimitedFetch(url, { headers: { 'Accept': 'application/json' } });
                    if (!res.ok) return;
                    const json = await res.json();
                    // users[] -> id -> { username, avatarTemplate }
                    const userById = new Map();
                    try {
                        const users = Array.isArray(json?.users) ? json.users : [];
                        for (const u of users) {
                            const id = typeof u?.id === 'number' ? u.id : null;
                            const username = u?.username ? String(u.username) : '';
                            const avatarTemplate = (u?.avatar_template || u?.avatarTemplate) ? String(u.avatar_template || u.avatarTemplate) : '';
                            if (!id || !username) continue;
                            userById.set(id, { username, avatarTemplate });
                        }
                    } catch {}

                    const avatarFromTemplate = (tpl, size) => {
                        const t = tpl ? String(tpl) : '';
                        if (!t) return '';
                        let url = t.replace(/\{size\}/gu, String(size || 96));
                        if (url.startsWith('/')) url = `${window.location.origin}${url}`;
                        return url;
                    };
                    const pickAuthor = (topic) => {
                        const posters = Array.isArray(topic?.posters) ? topic.posters : [];
                        if (!posters.length) return null;
                        const prefer =
                            posters.find((p) => /original poster|发起者|楼主|原作者/iu.test(String(p?.description || ''))) ||
                            posters[0];
                        const uid = typeof prefer?.user_id === 'number' ? prefer.user_id : null;
                        if (!uid) return null;
                        const u = userById.get(uid);
                        const username = u?.username ? String(u.username) : '';
                        if (!username) return null;
                        const avatar = avatarFromTemplate(u?.avatarTemplate, 96);
                        return { username, avatar };
                    };

                    const topics = json?.topic_list?.topics;
                    if (!Array.isArray(topics)) return;
                    for (const t of topics) {
                        if (!t || typeof t !== 'object') continue;
                        const tid = String(t.id);
                        if (!tid) continue;
                        const img = t.image_url || t.thumbnail_url || null;
                        const shape = this.extractImageShape({
                            imgW: t.image_width ?? t.imageWidth,
                            imgH: t.image_height ?? t.imageHeight,
                            imgAR: t.image_ratio ?? t.imageRatio
                        });
                        const likes = typeof t.like_count === 'number' ? t.like_count : 0;
                        const views = typeof t.views === 'number' ? t.views : 0;
                        const postsCount = typeof t.posts_count === 'number' ? t.posts_count : 0;
                        const highestPostNumber = typeof t.highest_post_number === 'number' ? t.highest_post_number : 0;
                        let replyCount = typeof t.reply_count === 'number' ? t.reply_count : 0;
                        // 为了保持与列表页展示一致，优先回退到 posts_count/highest_post_number 推断。
                        try {
                            const expectedFromPosts = (postsCount > 0) ? Math.max(0, postsCount - 1) : null;
                            const expectedFromHighest = (highestPostNumber > 0) ? Math.max(0, highestPostNumber - 1) : null;
                            const expected = (expectedFromPosts !== null) ? expectedFromPosts : expectedFromHighest;
                            if (expected !== null) {
                                const cur = Number(replyCount) || 0;
                                if (Math.abs(expected - cur) > 1) replyCount = expected;
                            }
                        } catch {}
                        const unreadPosts = typeof t.unread_posts === 'number' ? t.unread_posts : 0;
                        const newPosts = typeof t.new_posts === 'number' ? t.new_posts : 0;
                        const lastReadPostNumber = typeof t.last_read_post_number === 'number' ? t.last_read_post_number : 0;
                        const tags = Array.isArray(t.tags) ? t.tags : [];
                        const featuredLink = t.featured_link || '';
                        const author = pickAuthor(t);
                        this.listTopicMeta.set(tid, {
                            img,
                            imgW: shape.imgW,
                            imgH: shape.imgH,
                            imgAR: shape.imgAR,
                            likes,
                            views,
                            replyCount,
                            postsCount,
                            highestPostNumber,
                            unreadPosts,
                            newPosts,
                            lastReadPostNumber,
                            tags,
                            featuredLink,
                            author,
                            origin: 'list'
                        });
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

        applyAuthorMetaToCard(el, author) {
            const username = author?.username ? String(author.username) : '';
            if (!username) return;
            const avatarUrl = author?.avatar ? String(author.avatar) : '';
            const tid = String(el.dataset.tid || el.getAttribute('data-tid') || '');
            const meta = el.querySelector('.xhs-meta');
            if (!meta) return;
            const block = meta.querySelector('.xhs-user');
            if (!block) return;

            const nameSpan = block.querySelector('span');
            if (nameSpan) {
                const cur = (nameSpan.textContent || '').trim();
                if (!cur || cur === 'SJTUer') nameSpan.textContent = username;
            }
            const img = block.querySelector('img.xhs-avatar');
            if (img && avatarUrl) {
                const curSrc = img.getAttribute('src') || '';
                if (!curSrc || curSrc === 'about:blank') img.setAttribute('src', avatarUrl);
            }

            // 若当前不是可触发 user-card 的链接，则升级为 trigger-user-card（对移动端列表缺头像/用户名尤为重要）
            if (block.tagName === 'DIV') {
                const a = document.createElement('a');
                a.className = 'xhs-user trigger-user-card';
                a.href = `/u/${encodeURIComponent(username)}`;
                a.setAttribute('data-user-card', username);
                if (tid) {
                    a.setAttribute('data-topic-id', tid);
                    a.setAttribute('data-include-post-count-for', tid);
                }
                a.setAttribute('aria-label', `${username}，访问个人资料`);
                while (block.firstChild) a.appendChild(block.firstChild);
                block.replaceWith(a);
                el.dataset.userName = username;
                el.dataset.userHref = a.getAttribute('href') || '';
                return;
            }
            if (block.tagName === 'A') {
                if (!block.getAttribute('data-user-card')) block.setAttribute('data-user-card', username);
                if (!block.getAttribute('href')) block.setAttribute('href', `/u/${encodeURIComponent(username)}`);
                if (tid && !block.getAttribute('data-include-post-count-for')) block.setAttribute('data-include-post-count-for', tid);
                if (tid && !block.getAttribute('data-topic-id')) block.setAttribute('data-topic-id', tid);
                if (!block.getAttribute('aria-label')) block.setAttribute('aria-label', `${username}，访问个人资料`);
                el.dataset.userName = username;
                el.dataset.userHref = block.getAttribute('href') || '';
            }
        },

        applyUnreadMetaToCard(el, meta) {
            const tid = String(el?.dataset?.tid || el?.getAttribute?.('data-tid') || '');
            if (!tid) return;
            const cfg = Config.get();

            // 未读仅用于封面贴纸与卡片高亮，不在统计区插入额外 DOM
            if (!cfg.showUnreadPosts) {
                el.classList.remove('xhs-has-unread');
                return;
            }

            const unreadPosts = (typeof meta?.unreadPosts === 'number') ? meta.unreadPosts : (parseInt(meta?.unreadPosts, 10) || 0);
            if (!unreadPosts || unreadPosts <= 0) {
                el.classList.remove('xhs-has-unread');
                el.dataset.unreadPosts = '0';
                el.dataset.unreadHref = '';
                return;
            }

            const lastRead = (typeof meta?.lastReadPostNumber === 'number') ? meta.lastReadPostNumber : (parseInt(meta?.lastReadPostNumber, 10) || 0);
            const highest = (typeof meta?.highestPostNumber === 'number') ? meta.highestPostNumber : (parseInt(meta?.highestPostNumber, 10) || 0);
            let href = String(el.dataset.unreadHref || '');
            if (!href || href === '#') {
                let firstUnread = 1;
                if (lastRead > 0) firstUnread = lastRead + 1;
                else if (highest > 0) firstUnread = Math.max(1, highest - unreadPosts + 1);
                href = `/t/topic/${encodeURIComponent(tid)}/${firstUnread}`;
            }

            el.dataset.unreadPosts = String(unreadPosts);
            el.dataset.unreadHref = href;
            el.classList.add('xhs-has-unread');
        },

        applyImageCropForCover(cover, img) {
            const cfg = Config.get();
            if (!cfg.imgCropEnabled) return;
            if (!cover || !img) return;
            const w = img.naturalWidth || 0;
            const h = img.naturalHeight || 0;
            if (!w || !h) return;

            cover.classList.remove('xhs-img-crop', 'xhs-img-tall', 'xhs-img-wide');
            cover.style.removeProperty('--xhs-img-pos');
            cover.style.removeProperty('--xhs-crop-ar');
            cover.style.removeProperty('height');

            const base = Number(cfg.imgCropBaseRatio) || (4 / 3); // width / height
            const minAR = base / 2;
            const maxAR = base * 2;
            const wh = w / h;

            const applyFallbackHeight = (ratio) => {
                try {
                    if (window.CSS?.supports && window.CSS.supports('aspect-ratio: 1 / 1')) return;
                } catch {}
                try {
                    const cw = cover.clientWidth || 320;
                    const ch = Math.round(cw / (ratio || (4 / 3)));
                    const bounded = Math.min(520, Math.max(140, ch));
                    cover.style.height = `${bounded}px`;
                } catch {}
            };

            if (wh > maxAR) {
                cover.classList.add('xhs-img-crop', 'xhs-img-wide');
                cover.style.setProperty('--xhs-crop-ar', String(maxAR));
                applyFallbackHeight(maxAR);
                return;
            }
            if (wh < minAR) {
                cover.classList.add('xhs-img-crop', 'xhs-img-tall');
                cover.style.setProperty('--xhs-crop-ar', String(minAR));
                applyFallbackHeight(minAR);
                return;
            }
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
            this.rebuildColumnsWithCards(cards, cols);
        },

        rebuildColumnsWithCards(cards, desired) {
            if (!this.container) return;
            const cols = Math.max(1, parseInt(desired, 10) || 1);

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

            for (const card of Array.isArray(cards) ? cards : []) {
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

        syncListNoticeSpacing() {
            try {
                const body = document.body;
                const rootStyle = document.documentElement?.style;
                const clearSpacing = () => {
                    body?.classList?.remove?.('xhs-has-list-notice');
                    rootStyle?.removeProperty?.('--xhs-list-notice-offset');
                };
                if (!body || !Utils.isListLikePath() || !body.classList.contains('xhs-on')) {
                    clearSpacing();
                    return;
                }
                const mode = Config.get().listNoticeSpacingMode || 'smart';
                if (mode === 'off') {
                    clearSpacing();
                    return;
                }
                const notice = document.querySelector('.show-more.has-topics .alert, .show-more.has-topics a.alert, .show-more.has-topics button.alert');
                const grid = this.container || document.querySelector('.xhs-grid');
                if (!notice || !grid) {
                    clearSpacing();
                    return;
                }
                const rect = notice.getBoundingClientRect();
                const visible = (rect.width > 20 && rect.height > 8);
                if (!visible) {
                    clearSpacing();
                    return;
                }

                const gridRect = grid.getBoundingClientRect();
                const gridPaddingTop = parseFloat(getComputedStyle(grid).paddingTop || '0') || 0;
                const currentOffset = parseFloat(rootStyle?.getPropertyValue?.('--xhs-list-notice-offset') || '0') || 0;
                const basePaddingTop = Math.max(0, gridPaddingTop - currentOffset);
                const desiredGap = 8;
                const contentTop = gridRect.top + basePaddingTop;
                const overlapNeed = Math.ceil(rect.bottom + desiredGap - contentTop);

                let offset = 0;
                if (mode === 'legacy') {
                    offset = Math.min(72, Math.max(18, Math.ceil(rect.height + 10 - basePaddingTop)));
                } else {
                    // smart：按“提醒底部”与“卡片内容起点”的真实交叠计算，避免出现过大空白
                    offset = Math.min(56, Math.max(0, overlapNeed));
                    if (offset <= 0) {
                        clearSpacing();
                        return;
                    }
                }
                rootStyle?.setProperty?.('--xhs-list-notice-offset', `${offset}px`);
                body.classList.add('xhs-has-list-notice');
            } catch {}
        },

        applyCoverPreferenceToCard(card) {
            const el = card?.nodeType === 1 ? card : null;
            if (!el) return;
            const tid = String(el.getAttribute('data-tid') || el.dataset?.tid || '');
            if (!tid) return;
            const cfg = Config.get();
            const coverStyle = this.applyTextCoverStyleToCard(el, cfg);
            const hidden = Config.isCoverHidden(tid);
            const cover = el.querySelector('.xhs-cover');
            if (cover) {
                if (hidden) {
                    cover.querySelectorAll('img.xhs-real-img').forEach((img) => img.remove());
                    cover.classList.remove('has-img', 'xhs-img-crop', 'xhs-img-tall', 'xhs-img-wide');
                    cover.style.removeProperty('--xhs-img-pos');
                    cover.style.removeProperty('--xhs-crop-ar');
                    cover.style.removeProperty('height');
                } else {
                    const hasRealImg = Boolean(cover.querySelector('img.xhs-real-img'));
                    if (!hasRealImg) {
                        const cached = this.cache.get(tid);
                        if (cached?.img) {
                            const img = document.createElement('img');
                            img.src = cached.img;
                            img.className = 'xhs-real-img';
                            this.applyImageShapeToImg(img, cached);
                            img.onload = () => {
                                img.classList.add('loaded');
                                try { this.applyImageCropForCover(cover, img); } catch {}
                            };
                            cover.prepend(img);
                        }
                    }
                    const nowHasImg = Boolean(cover.querySelector('img.xhs-real-img'));
                    cover.classList.toggle('has-img', nowHasImg);
                }
            }
            el.classList.toggle('xhs-cover-hidden', hidden);
            const btn = el.querySelector('.xhs-cover-toggle[data-action="toggle-cover"]');
            if (btn) {
                btn.classList.toggle('is-hidden', hidden);
                btn.textContent = hidden ? '🙈' : '🖼️';
                btn.setAttribute('aria-pressed', el.classList.contains('xhs-cover-menu-open') ? 'true' : 'false');
                btn.setAttribute('title', '封面选项（点击或悬浮展开）');
                btn.setAttribute('aria-label', '封面选项（点击或悬浮展开）');
            }
            const menuToggle = el.querySelector('.xhs-cover-toggle-item[data-action="cover-menu-toggle"]');
            if (menuToggle) {
                menuToggle.classList.toggle('is-active', hidden);
                menuToggle.textContent = hidden ? '主图' : '仅文';
                const tip = hidden ? '切换为主楼图封面' : '切换为仅文字封面';
                menuToggle.setAttribute('title', tip);
                menuToggle.setAttribute('aria-label', tip);
                menuToggle.setAttribute('aria-pressed', hidden ? 'true' : 'false');
            }
            const overrideStyle = Config.getCoverStyleOverride(tid);
            el.querySelectorAll('.xhs-cover-toggle-item[data-action="cover-menu-style"][data-style]').forEach((item) => {
                const style = String(item.getAttribute('data-style') || '').trim();
                const isAuto = style === 'auto';
                const isActive = isAuto ? !overrideStyle : style === overrideStyle;
                const isCurrent = !isAuto && style === coverStyle;
                item.classList.toggle('is-active', isActive);
                item.classList.toggle('is-current', isCurrent);
                item.setAttribute('aria-pressed', isActive ? 'true' : 'false');
                const badge = this._getCoverStyleBadge(style);
                const tip = isAuto ? '跟随全局封面风格' : `切换为${badge.name}`;
                item.setAttribute('title', tip);
                item.setAttribute('aria-label', tip);
            });
            if (!hidden) {
                el.classList.remove('xhs-cover-menu-open');
            }
        },

        _getCoverStyleBadge(style) {
            const s = String(style || '').trim();
            const safe = (s === 'classic' || s === 'notebook' || s === 'glass' || s === 'collage' || s === 'auto') ? s : 'classic';
            const map = {
                auto: { short: '跟', name: '跟随全局' },
                classic: { short: '经', name: '经典' },
                notebook: { short: '笔', name: '笔记' },
                glass: { short: '玻', name: '毛玻璃' },
                collage: { short: '贴', name: '大字报拼贴风' }
            };
            return map[safe] || map.classic;
        },

        _resolveCoverStyleForTopic(tid, cfg) {
            const key = String(tid || '').trim();
            const currentCfg = cfg || Config.get();
            const override = Config.getCoverStyleOverride(key);
            if (override) return override;
            return this._resolveTextCoverStyle(currentCfg.textCoverStyle || 'classic', key, currentCfg.textCoverMixPool);
        },

        applyTextCoverStyleToCard(card, cfg) {
            const el = card?.nodeType === 1 ? card : null;
            if (!el) return 'classic';
            const tid = String(el.getAttribute('data-tid') || el.dataset?.tid || '');
            if (!tid) return 'classic';
            const coverStyle = this._resolveCoverStyleForTopic(tid, cfg);
            const textCover = el.querySelector('.xhs-text-cover');
            if (!textCover) return coverStyle;

            textCover.classList.remove(
                'xhs-text-cover-notebook',
                'xhs-text-cover-glass',
                'xhs-text-cover-collage',
                'xhs-text-cover-notebook-normal',
                'xhs-text-cover-notebook-tall',
                'xhs-text-cover-glass-normal',
                'xhs-text-cover-glass-tall',
                'xhs-text-cover-collage-normal',
                'xhs-text-cover-collage-tall'
            );
            if (coverStyle !== 'classic') {
                textCover.classList.add(`xhs-text-cover-${coverStyle}`);
            }
            const excerptText = textCover.querySelector('.xhs-text-excerpt')?.textContent || '';
            const sizeClass = String(this._getTextCoverSizeClass(coverStyle, excerptText) || '').trim();
            if (sizeClass) textCover.classList.add(sizeClass);

            const excerptEl = textCover.querySelector('.xhs-text-excerpt');
            if (excerptEl) {
                const coverRand = Utils.seededRandom(tid + '_cover2');
                const hasEmoji = Boolean(textCover.querySelector('.xhs-emoji-icon'));
                const useDropcap = coverStyle === 'classic' && coverRand() < 0.42 && !hasEmoji;
                excerptEl.classList.toggle('dropcap', useDropcap);
            }
            textCover.dataset.coverStyle = coverStyle;
            return coverStyle;
        },

        applyCoverPreferenceToAllCards(tid) {
            const key = String(tid || '').trim();
            if (!key) return;
            const selector = `.xhs-card[data-tid="${CSS.escape(key)}"]`;
            document.querySelectorAll(selector).forEach((card) => this.applyCoverPreferenceToCard(card));
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
            const origin = (data.origin === 'topic' || data.origin === 'list') ? data.origin : '';
            const shape = this.extractImageShape(data);
            return {
                img: data.img ?? null,
                imgW: shape.imgW,
                imgH: shape.imgH,
                imgAR: shape.imgAR,
                likes: typeof data.likes === 'number' ? data.likes : (parseInt(data.likes, 10) || 0),
                views: (() => {
                    const v = (typeof data.views === 'number') ? data.views : parseInt(data.views, 10);
                    return Number.isFinite(v) && v >= 0 ? v : null;
                })(),
                replyCount: (() => {
                    const v = (typeof data.replyCount === 'number') ? data.replyCount : parseInt(data.replyCount, 10);
                    return Number.isFinite(v) && v >= 0 ? v : null;
                })(),
                noImg: Boolean(data.noImg),
                origin
            };
        },

        _setPersistentData(tid, data) {
            const cfg = Config.get();
            if (!cfg.cacheEnabled) return;
            this.loadPersistentCache();
            const now = Date.now();
            const key = String(tid || '');
            if (!key) return;
            const origin = (data?.origin === 'topic' || data?.origin === 'list') ? data.origin : '';
            const prev = this.persistentCache.get(key);
            const prevData = prev?.data || null;
            const shape = this.extractImageShape(data);
            const prevShape = this.extractImageShape(prevData);
            const nextShape = {
                imgW: shape.imgW || prevShape.imgW || null,
                imgH: shape.imgH || prevShape.imgH || null,
                imgAR: shape.imgAR || prevShape.imgAR || null
            };
            if (!nextShape.imgAR && nextShape.imgW && nextShape.imgH) {
                nextShape.imgAR = nextShape.imgW / nextShape.imgH;
            }

            const next = {
                img: data?.img || null,
                likes: typeof data?.likes === 'number' ? data.likes : (parseInt(data?.likes, 10) || 0),
                noImg: Boolean(data?.noImg),
                origin
            };

            const nextViews = (() => {
                const v = (typeof data?.views === 'number') ? data.views : parseInt(data?.views, 10);
                if (Number.isFinite(v) && v >= 0) return v;
                const pv = (typeof prevData?.views === 'number') ? prevData.views : parseInt(prevData?.views, 10);
                return Number.isFinite(pv) && pv >= 0 ? pv : null;
            })();
            const nextReplyCount = (() => {
                const v = (typeof data?.replyCount === 'number') ? data.replyCount : parseInt(data?.replyCount, 10);
                if (Number.isFinite(v) && v >= 0) return v;
                const pv = (typeof prevData?.replyCount === 'number') ? prevData.replyCount : parseInt(prevData?.replyCount, 10);
                return Number.isFinite(pv) && pv >= 0 ? pv : null;
            })();
            if (nextViews !== null) next.views = nextViews;
            if (nextReplyCount !== null) next.replyCount = nextReplyCount;
            if (nextShape.imgW) next.imgW = nextShape.imgW;
            if (nextShape.imgH) next.imgH = nextShape.imgH;
            if (nextShape.imgAR) next.imgAR = nextShape.imgAR;

            const same =
                prevData &&
                prevData.img === next.img &&
                (prevData.likes || 0) === (next.likes || 0) &&
                Boolean(prevData.noImg) === Boolean(next.noImg) &&
                (this.toPositiveInt(prevData.imgW) || 0) === (this.toPositiveInt(next.imgW) || 0) &&
                (this.toPositiveInt(prevData.imgH) || 0) === (this.toPositiveInt(next.imgH) || 0) &&
                Math.abs((this.toPositiveNumber(prevData.imgAR) || 0) - (this.toPositiveNumber(next.imgAR) || 0)) < 0.0001 &&
                String(prevData.origin || '') === String(next.origin || '');
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
            const existing = this.cache.get(tid) || { img: null, likes: 0, needsImage: true, imgW: null, imgH: null, imgAR: null };
            const noImg = Boolean(meta?.noImg);
            const origin = (meta?.origin === 'topic' || meta?.origin === 'list') ? meta.origin : '';
            let mergedOrigin = origin || existing.origin || '';
            if (origin === 'list' && existing.origin === 'topic') {
                const listImg = this.normalizeImageUrl(meta?.img || '');
                const cachedImg = this.normalizeImageUrl(existing?.img || '');
                // 若列表图与已验证封面一致（或列表无图），保留 topic 来源，允许后续懒校验。
                if (!listImg || !cachedImg || listImg === cachedImg) mergedOrigin = 'topic';
            }
            const nextShape = this.extractImageShape(meta);
            const prevShape = this.extractImageShape(existing);
            const mergedShape = {
                imgW: nextShape.imgW || prevShape.imgW || null,
                imgH: nextShape.imgH || prevShape.imgH || null,
                imgAR: nextShape.imgAR || prevShape.imgAR || null
            };
            if (!mergedShape.imgAR && mergedShape.imgW && mergedShape.imgH) {
                mergedShape.imgAR = mergedShape.imgW / mergedShape.imgH;
            }
            const merged = {
                img: meta.img ?? existing.img ?? null,
                imgW: mergedShape.imgW,
                imgH: mergedShape.imgH,
                imgAR: mergedShape.imgAR,
                likes: (typeof meta.likes === 'number' ? meta.likes : existing.likes) || 0,
                // noImg 只有在“已被 topic.json 验证”时才强制阻止后续请求；否则允许再验证一次，避免老缓存误判
                needsImage: (noImg && origin === 'topic') ? false : Boolean(existing.needsImage),
                noImg,
                origin: mergedOrigin
            };
            if (merged.img) merged.needsImage = false;
            this.cache.set(tid, merged);

            const likeEl = el.querySelector('.xhs-like-count');
            if (likeEl) likeEl.textContent = Utils.formatStatCount(merged.likes ?? 0);

            // 统计：views / replies（移动端列表 DOM 常缺失 views，这里用 list.json 补齐；同时避免大数显示 0）
            try {
                const views = typeof meta?.views === 'number' ? meta.views : null;
                const replyCount = typeof meta?.replyCount === 'number' ? meta.replyCount : null;
                if (views !== null && views >= 0) el.dataset.viewNum = String(views);
                if (replyCount !== null && replyCount >= 0) el.dataset.replyNum = String(replyCount);

                const repliesLink = el.querySelector('.xhs-replies-link');
                if (repliesLink && replyCount !== null) {
                    const replyNum = Utils.parseCount(replyCount);
                    repliesLink.textContent = `💬 ${Utils.formatStatCount(replyNum)}`;
                    repliesLink.setAttribute('aria-label', `${String(replyNum)} 条回复，跳转到第一个帖子`);
                }
                const viewsEl = el.querySelector('.xhs-views');
                if (viewsEl && views !== null) {
                    const viewNum = Utils.parseCount(views);
                    viewsEl.textContent = `👁️ ${Utils.formatStatCount(viewNum)}`;
                }
            } catch {}
            
            // 作者信息（移动端列表常见：DOM 里拿不到头像/用户名，这里用 list.json 补齐）
            try {
                if (meta.author) this.applyAuthorMetaToCard(el, meta.author);
            } catch {}
            
            // 未读帖子（跟踪/关注的话题会在 list.json 里提供 unread_posts/last_read_post_number）
            try {
                this.applyUnreadMetaToCard(el, meta);
            } catch {}
            
            // 贴纸优先级：未读更新往往晚于点赞/封面，必须在 applyUnreadMetaToCard 之后再算一次
            try { this.updateStickerForCard(el, merged.likes ?? 0); } catch {}

            if (merged.img) {
                const cover = el.querySelector('.xhs-cover');
                const coverHidden = Config.isCoverHidden(tid);
                if (cover && !coverHidden) {
                    const existingImg = cover.querySelector('img.xhs-real-img');
                    const expectedSrc = this.normalizeImageUrl(merged.img);
                    const existingSrc = this.normalizeImageUrl(existingImg?.getAttribute?.('src') || existingImg?.src || '');
                    const shouldReplace = !existingImg || expectedSrc !== existingSrc;
                    if (shouldReplace) {
                        const img = document.createElement('img');
                        img.src = merged.img;
                        img.className = 'xhs-real-img';
                        this.applyImageShapeToImg(img, merged);
                        img.onload = () => {
                            img.classList.add('loaded');
                            try { this.applyImageCropForCover(cover, img); } catch {}
                        };
                        cover.querySelector('img.xhs-real-img')?.remove();
                        cover.prepend(img);
                    } else {
                        this.applyImageShapeToImg(existingImg, merged);
                    }
                }
                if (cover) {
                    const hasRealImg = Boolean(cover.querySelector('img.xhs-real-img'));
                    cover.classList.toggle('has-img', hasRealImg);
                }
            } else if (opts?.fromList) {
                // 列表未提供 image_url，保持需要进一步按需抓取 cooked 的状态
                // 如果 noImg 未验证（origin 不是 topic），也允许继续抓取一次验证
                if (!noImg || origin !== 'topic') this.cache.set(tid, { ...merged, needsImage: true });
            }

            this.applyCoverPreferenceToCard(el);

            // 列表 JSON 的结果也写入跨页面缓存（避免下次进来还要 per-topic 请求）
            try {
                if (opts?.fromList) this._setPersistentData(tid, {
                    img: merged.img || null,
                    imgW: merged.imgW || null,
                    imgH: merged.imgH || null,
                    imgAR: merged.imgAR || null,
                    likes: merged.likes || 0,
                    views: (typeof meta?.views === 'number') ? meta.views : null,
                    replyCount: (typeof meta?.replyCount === 'number') ? meta.replyCount : null,
                    noImg: merged.noImg,
                    origin: merged.origin || 'list'
                });
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

        reorderCardsByTidOrder(tidOrder, opts) {
            if (!this.container) return;
            const order = Array.isArray(tidOrder) ? tidOrder.map((t) => String(t)).filter(Boolean) : [];
            if (!order.length) return;

            const cards = Array.from(this.container.querySelectorAll('.xhs-card[data-tid]'));
            const tidToCard = new Map();
            for (const card of cards) {
                const tid = String(card.getAttribute('data-tid') || '');
                if (!tid || tidToCard.has(tid)) continue;
                tidToCard.set(tid, card);
            }

            const ordered = [];
            const used = new Set();
            for (const tid of order) {
                const card = tidToCard.get(tid);
                if (!card) continue;
                ordered.push(card);
                used.add(tid);
            }
            for (const card of cards) {
                const tid = String(card.getAttribute('data-tid') || '');
                if (tid && used.has(tid)) continue;
                ordered.push(card);
            }

            const highlight = () => {
                if (!opts?.highlightTids || !opts.highlightTids.length) return;
                const set = new Set(opts.highlightTids.map((t) => String(t)));
                requestAnimationFrame(() => {
                    try {
                        for (const card of this.container.querySelectorAll('.xhs-card[data-tid]')) {
                            const tid = String(card.getAttribute('data-tid') || '');
                            if (tid && set.has(tid)) this.flashCard(card);
                        }
                    } catch {}
                });
            };

            const cfg = Config.get();
            if (!cfg.cardStagger) {
                // grid-mode：直接按顺序重新 append
                this.container.textContent = '';
                for (const card of ordered) this.container.appendChild(card);
                highlight();
                return;
            }

            const desired = this.getDesiredColumnCount();
            this.rebuildColumnsWithCards(ordered, desired);
            highlight();
        },

        resetObserver() {
            try { this.observer?.disconnect?.(); } catch {}
            this.observer = new IntersectionObserver((entries) => {
                entries.forEach(e => {
                    if (e.isIntersecting) {
                        const tid = e.target.dataset.tid;
                        const cached = tid ? this.cache.get(tid) : null;
                        const forceRefresh = tid ? this.shouldForceRefreshCover(tid, cached) : false;
                        if (tid && (!cached || cached.needsImage || forceRefresh)) {
                            this.queue.push({ el: e.target, tid, forceRefresh });
                            this.processQueue();
                        }
                        this.observer.unobserve(e.target);
                    }
                });
            }, { rootMargin: (Config.get().overfetchMode ? '1600px' : '200px') });

            try {
                if (this.container) {
                    this.container.querySelectorAll('.xhs-card[data-tid]').forEach((card) => {
                        try { this.observer.observe(card); } catch {}
                    });
                }
            } catch {}
        },

        ensureContainer() {
            const list = document.querySelector('.topic-list');
            if (!list) return false;
            try {
                if (!this.container) {
                    this.container = document.createElement('div');
                    this.container.className = `xhs-grid ${Config.get().cardStagger ? '' : 'grid-mode'}`;
                    list.parentNode.insertBefore(this.container, list);
                    this.renderedTids = new Set();
                    this.ensureColumns(false);
                } else if (this.container.parentNode !== list.parentNode || this.container.nextSibling !== list) {
                    // Discourse SPA 下 DOM 可能被重建：确保容器仍在 topic-list 之前
                    list.parentNode.insertBefore(this.container, list);
                }
            } catch {}
            return Boolean(this.container);
        },

        setupListUpdating() {
            if (this.bodyObserver) return;
            // 兜底：监听 body 变化，自动处理新增帖子（较稳但可能更频繁）
            this.bodyObserver = new MutationObserver((mutations) => {
                let shouldUpdate = false;
                for (let m of mutations) {
                    if (m.addedNodes.length && m.target.classList && !m.target.classList.contains('xhs-grid')) {
                        shouldUpdate = true;
                        break;
                    }
                }
                if (shouldUpdate && Utils.isListPage()) this.scheduleRender();
            });
            try { this.bodyObserver.observe(document.body, { childList: true, subtree: true }); } catch {}
        },

        init() {
            this.loadPersistentCache();
            this.applyRateLimitConfig();
            this.ensureListMetaLoaded();
            this.setupListUpdating();
            window.addEventListener('xhs-route-change', Utils.debounce(() => {
                try {
                    this.ensureListMetaLoaded();
                    this.setupListUpdating();
                } catch {}
            }, 120));
            
            // 可见性观察器：用于懒加载详情（支持“过加载模式”扩大预取范围）
            this.resetObserver();

            // 视口变化时，列数可能变化：仅在“错落布局”模式下重建列（不做全局重排，尽量减少抖动）
            window.addEventListener('resize', Utils.debounce(() => {
                try {
                    const cfg = Config.get();
                    if (!cfg.enabled) return;
                    if (!document.body.classList.contains('xhs-on')) return;
                    if (!Utils.isListLikePath()) return;
                    this.syncListNoticeSpacing();
                    if (!cfg.cardStagger) return;
                    if (!this.container) return;
                    // iOS Safari 会在滚动时因地址栏/工具栏显隐频繁触发 resize（宽度不变，高度变化），
                    // 若强制重建分列会导致卡片不断“洗牌”。这里只在列数确实需要变化时才重建。
                    this.ensureColumns(false);
                } catch {}
            }, 180));
        },

        applyRateLimitConfig() {
            const cfg = Config.get();
            const rl = this.rateLimit;
            rl.enabled = Boolean(cfg.rateLimitEnabled);
            rl.autoTune = Boolean(cfg.rateAutoTune);
            rl.baseInterval = Number(cfg.rateMinIntervalMs) || 350;
            rl.cooldownMs = (Number(cfg.rateCooldownSeconds) || 5) * 1000;
            if (!Number.isFinite(rl.interval) || rl.interval <= 0) rl.interval = rl.baseInterval;
            rl.interval = Math.min(rl.maxInterval, Math.max(rl.baseInterval, rl.interval));
            if (!Number.isFinite(rl.lastReqAt)) rl.lastReqAt = 0;
            if (!Number.isFinite(rl.cooldownUntil)) rl.cooldownUntil = 0;
        },

        async _withRateLimitLock(fn) {
            const prev = this.rateLimitLock;
            let release;
            this.rateLimitLock = new Promise((r) => { release = r; });
            try { await prev; } catch {}
            try { return await fn(); } finally { try { release?.(); } catch {} }
        },

        _parseRetryAfterMs(res) {
            try {
                const v = res?.headers?.get?.('Retry-After');
                if (!v) return 0;
                const n = parseInt(v, 10);
                if (Number.isFinite(n) && n >= 0) return n * 1000;
                const t = Date.parse(v);
                if (Number.isFinite(t)) return Math.max(0, t - Date.now());
                return 0;
            } catch { return 0; }
        },

        async _rateLimitedFetch(url, init) {
            const cfg = Config.get();
            if (!cfg.rateLimitEnabled) return fetch(url, init);

            return await this._withRateLimitLock(async () => {
                const rl = this.rateLimit;
                const now0 = Date.now();

                // 冷却优先
                if (now0 < rl.cooldownUntil) await Utils.sleep(rl.cooldownUntil - now0);

                // 最小间隔
                const now1 = Date.now();
                const next = (rl.lastReqAt || 0) + (rl.interval || rl.baseInterval || 350);
                if (now1 < next) await Utils.sleep(next - now1);

                rl.lastReqAt = Date.now();
                const res = await fetch(url, init);

                if (res.status === 429) {
                    const retryAfter = this._parseRetryAfterMs(res);
                    rl.last429At = Date.now();
                    rl.cooldownUntil = rl.last429At + Math.max(rl.cooldownMs || 0, retryAfter || 0);
                    if (rl.autoTune) {
                        rl.interval = Math.min(rl.maxInterval || 2500, Math.ceil((rl.interval || rl.baseInterval || 350) * 1.6));
                        rl.tuned = true;
                    }
                } else if (res.ok) {
                    // 成功后缓慢恢复到 baseInterval
                    if (rl.autoTune && rl.interval > rl.baseInterval) {
                        rl.interval = Math.max(rl.baseInterval, rl.interval - 40);
                    } else if (!rl.autoTune) {
                        rl.interval = Math.max(rl.baseInterval, Math.min(rl.maxInterval || 2500, rl.interval || rl.baseInterval));
                    }
                }

                return res;
            });
        },

        // 处理请求队列 (带退避算法)
        async processQueue() {
            if (this.processing || !this.queue.length) return;
            this.processing = true;

            const task = this.queue.shift();
            const { el, tid, forceRefresh = false } = task || {};
            if (!el || !tid) {
                this.processing = false;
                this.processQueue();
                return;
            }
            
            try {
                const data = await this.fetchTopic(tid, { forceRefresh });
                this.updateCard(el, data);
            } catch (e) {
                // 失败（如429），增加冷却并放回队列
                if (e.status === 429) {
                    this.queue.unshift(task); // 放回队头
                } else if (forceRefresh) {
                    this.coverRevalidatedInSession.delete(String(tid || ''));
                }
                console.warn('[XHS] Fetch error:', e);
            }

            // 继续处理下一个（实际节流由 _rateLimitedFetch 控制）
            setTimeout(() => {
                this.processing = false;
                this.processQueue();
            }, 0);
        },

        async fetchTopic(tid, opts) {
            const forceRefresh = Boolean(opts?.forceRefresh);
            const cfg = Config.get();
            if (cfg.cacheEnabled && !forceRefresh) {
                const cachedData = this._getPersistentData(String(tid));
                // 仅当“确实拿到封面图”或“已被 topic.json 验证无图”时才命中缓存；
                // list.json 的 img=null/noImg=false 只代表“列表没给图”，不能阻止后续抓取 cooked。
                if (cachedData) {
                    const origin = cachedData.origin;
                    const needViews = Boolean(cfg.showStats && cfg.showStatViews);
                    const needReplies = Boolean(cfg.showStats && cfg.showStatReplies);
                    const listMeta = this.listTopicMeta.get(String(tid));
                    const missingStats =
                        (needViews && typeof cachedData.views !== 'number' && typeof listMeta?.views !== 'number') ||
                        (needReplies && typeof cachedData.replyCount !== 'number' && typeof listMeta?.replyCount !== 'number');

                    if (!missingStats) {
                        if (cachedData.img) return cachedData;
                        if (cachedData.noImg && origin === 'topic') return cachedData;
                    }
                    // 其它情况（含旧缓存/列表缓存/未验证 noImg）继续请求 topic.json 再确认一次
                }
            }

            const res = await this._rateLimitedFetch(`/t/topic/${tid}.json`, { headers: { 'Accept': 'application/json' } });
            if (!res.ok) throw { status: res.status };
            const json = await res.json();
            
            // 提取图片
            const cooked = json.post_stream?.posts?.[0]?.cooked || '';
            // 注意：不要用 div.innerHTML + img.src 直接解析 cooked，会触发浏览器预加载图片，增加网络/服务器压力。
            // 用 DOMParser + getAttribute 仅提取 URL/尺寸/类名信息。
            const doc = new DOMParser().parseFromString(cooked, 'text/html');
            
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

            const pickSrc = (img) => {
                if (!img) return '';
                const raw =
                    img.getAttribute('src') ||
                    img.getAttribute('data-src') ||
                    img.getAttribute('data-original') ||
                    img.getAttribute('data-orig-src') ||
                    '';
                return String(raw || '').trim();
            };
            const normalizeUrl = (src) => {
                const s = String(src || '').trim();
                if (!s) return '';
                try { return new URL(s, window.location.origin).href; } catch { return s; }
            };

            // 选择“更像封面图”的图片，避免 onebox/favicon 等小图被误当封面。
            const imgs = Array.from(doc.querySelectorAll('img'))
                .map((img) => {
                    const rawSrc = pickSrc(img);
                    const src = normalizeUrl(rawSrc);
                    const width = getDim(img, 'width');
                    const height = getDim(img, 'height');
                    const ratio = (width && height) ? (width / height) : null;
                    const inOnebox = Boolean(img.closest?.('.onebox'));
                    const className = String(img.getAttribute('class') || '').toLowerCase();
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

                    return { src, score, imgW: width || null, imgH: height || null, imgAR: ratio || null };
                }) 
                .filter((x) => x.score > 0)
                .sort((a, b) => b.score - a.score);
            const best = imgs[0] || null;
            
            return {
                img: best?.src || null,
                imgW: best?.imgW || null,
                imgH: best?.imgH || null,
                imgAR: best?.imgAR || null,
                likes: json.like_count || 0,
                views: (typeof json.views === 'number') ? json.views : null,
                replyCount: (() => {
                    const postsCount = typeof json.posts_count === 'number' ? json.posts_count : 0;
                    const highestPostNumber = typeof json.highest_post_number === 'number' ? json.highest_post_number : 0;
                    let replyCount = typeof json.reply_count === 'number' ? json.reply_count : 0;
                    // 为了保持与列表页展示一致，优先回退到 posts_count/highest_post_number 推断。
                    try {
                        const expectedFromPosts = (postsCount > 0) ? Math.max(0, postsCount - 1) : null;
                        const expectedFromHighest = (highestPostNumber > 0) ? Math.max(0, highestPostNumber - 1) : null;
                        const expected = (expectedFromPosts !== null) ? expectedFromPosts : expectedFromHighest;
                        if (expected !== null) {
                            const cur = Number(replyCount) || 0;
                            if (Math.abs(expected - cur) > 1) replyCount = expected;
                        }
                    } catch {}
                    return replyCount;
                })(),
                noImg: imgs.length === 0,
                origin: 'topic'
            };
        },

        updateCard(el, data) {
            const tid = String(el.dataset.tid);
            const existing = this.cache.get(tid) || { img: null, likes: 0, needsImage: true, imgW: null, imgH: null, imgAR: null };
            const noImg = Boolean(data?.noImg);
            const origin = (data?.origin === 'topic' || data?.origin === 'list') ? data.origin : '';
            const nextShape = this.extractImageShape(data);
            const prevShape = this.extractImageShape(existing);
            const mergedShape = {
                imgW: nextShape.imgW || prevShape.imgW || null,
                imgH: nextShape.imgH || prevShape.imgH || null,
                imgAR: nextShape.imgAR || prevShape.imgAR || null
            };
            if (!mergedShape.imgAR && mergedShape.imgW && mergedShape.imgH) {
                mergedShape.imgAR = mergedShape.imgW / mergedShape.imgH;
            }
            const merged = {
                img: data.img ?? existing.img ?? null,
                imgW: mergedShape.imgW,
                imgH: mergedShape.imgH,
                imgAR: mergedShape.imgAR,
                likes: (typeof data.likes === 'number' ? data.likes : existing.likes) ?? 0,
                needsImage: noImg ? false : !Boolean(data.img),
                noImg,
                origin: origin || existing.origin || ''
            };
            this.cache.set(tid, merged);

            // 写入跨页面缓存（最小化内容，仅保存必要字段）
            try {
                this._setPersistentData(tid, {
                    img: merged.img || null,
                    imgW: merged.imgW || null,
                    imgH: merged.imgH || null,
                    imgAR: merged.imgAR || null,
                    likes: merged.likes || 0,
                    views: (typeof data?.views === 'number') ? data.views : null,
                    replyCount: (typeof data?.replyCount === 'number') ? data.replyCount : null,
                    noImg: merged.noImg,
                    origin: merged.origin || 'topic'
                });
            } catch {}
            
            // 更新点赞数
            const likeEl = el.querySelector('.xhs-like-count');
            if (likeEl) likeEl.textContent = Utils.formatStatCount(merged.likes ?? 0);
            this.updateStickerForCard(el, merged.likes ?? 0);

            // 更新统计（views / replies）：用于移动端/深翻页列表在 DOM 缺失统计时避免显示 0
            try {
                const views = (typeof data?.views === 'number') ? data.views : null;
                if (views !== null && views >= 0) {
                    el.dataset.viewNum = String(views);
                    const viewsEl = el.querySelector('.xhs-views');
                    if (viewsEl) viewsEl.textContent = `👁️ ${Utils.formatStatCount(views)}`;
                }
                const replyCount = (typeof data?.replyCount === 'number') ? data.replyCount : null;
                if (replyCount !== null && replyCount >= 0) {
                    el.dataset.replyNum = String(replyCount);
                    const repliesLink = el.querySelector('.xhs-replies-link');
                    if (repliesLink) {
                        repliesLink.textContent = `💬 ${Utils.formatStatCount(replyCount)}`;
                        repliesLink.setAttribute('aria-label', `${String(replyCount)} 条回复，跳转到第一个帖子`);
                    }
                }
            } catch {}

            // 如果有图，替换封面
            if (merged.img) {
                const cover = el.querySelector('.xhs-cover');
                const coverHidden = Config.isCoverHidden(tid);
                if (cover && !coverHidden) {
                    const img = document.createElement('img');
                    img.src = merged.img;
                    img.className = 'xhs-real-img';
                    this.applyImageShapeToImg(img, merged);
                    img.onload = () => {
                        img.classList.add('loaded');
                        try { this.applyImageCropForCover(cover, img); } catch {}
                    };

                    cover.querySelector('img.xhs-real-img')?.remove();
                    cover.prepend(img);
                }
                if (cover) {
                    const hasRealImg = Boolean(cover.querySelector('img.xhs-real-img'));
                    cover.classList.toggle('has-img', hasRealImg);
                }
            }
            this.applyCoverPreferenceToCard(el);
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

            // v4.13：保持 Discourse 的 latest 顺序（仅在“刷新”语义发生时重排，避免无限下拉时打断阅读）
            const shouldReorder =
                this.forceReorderOnNextRender ||
                (isTopRefresh && (window.scrollY || 0) < 600);
            if (shouldReorder) {
                this.forceReorderOnNextRender = false;
                this.reorderCardsByTidOrder(tidListAll, { highlightTids: bumpedTids });
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

            if (bumpedTids.length && !shouldReorder) {
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

            this.syncListNoticeSpacing();
        },

        createCard(row) {
            const titleLink = row.querySelector('.main-link a.title, a.title');
            const title = titleLink?.textContent?.trim() || '';
            const href = titleLink?.href || titleLink?.getAttribute?.('href') || '';
            const tid = row.dataset.topicId || Utils.extractTopicIdFromUrl(href);
            const listMeta = this.listTopicMeta.get(String(tid));
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
            const viewsEl = row.querySelector('.views .number');
            const postsEl = row.querySelector('.posts .number');
            const views = viewsEl?.textContent || '0';
            const replies = postsEl?.textContent || '0';
            const lastActivityEl =
                row.querySelector('td.last-posted .relative-date, .last-posted .relative-date') ||
                row.querySelector('td.activity .relative-date, .activity .relative-date') ||
                row.querySelector('td.age .relative-date, .age .relative-date') ||
                row.querySelector('.relative-date');
            const lastActivity = lastActivityEl?.textContent?.trim?.() || '';
            const lastActivityTitle = lastActivityEl?.getAttribute?.('title') || '';
            const excerpt = row.querySelector('.topic-excerpt')?.textContent?.trim() || title;
            const pinned = row.classList.contains('pinned');
            const unreadAnchor =
                row.querySelector('.topic-post-badges a.badge-notification.unread-posts') ||
                row.querySelector('a.badge-notification.unread-posts');
            const unreadText = unreadAnchor?.textContent?.trim?.() || '';
            const unreadHref = unreadAnchor?.getAttribute?.('href') || unreadAnchor?.href || '';
            const unreadNum = Utils.parseCount(unreadText);
            const cfg = Config.get();
            let featuredDomain = '';
            if (featuredLink) {
                try {
                    featuredDomain = new URL(featuredLink).hostname;
                } catch {}
            }
            const replyFromDom = Utils.parseCount(replies);
            const viewFromDom = Utils.parseCount(views);
            const listReply = (typeof listMeta?.replyCount === 'number') ? listMeta.replyCount : null;
            const listViews = (typeof listMeta?.views === 'number') ? listMeta.views : null;
            const replyNum = (replyFromDom > 0) ? replyFromDom : (listReply !== null ? listReply : replyFromDom);
            const viewNum = (viewFromDom > 0) ? viewFromDom : (listViews !== null ? listViews : viewFromDom);
            const repliesDisplay = Utils.formatStatCount(replyNum);
            const viewsDisplay = Utils.formatStatCount(viewNum);

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
            card.dataset.title = title || '';
            card.dataset.unreadPosts = String(unreadNum || 0);
            card.dataset.unreadHref = String(unreadHref || '');
            if (cfg.showUnreadPosts && unreadNum > 0) card.classList.add('xhs-has-unread');

            // 1. 生成初始封面（默认文字版，稍后异步加载图片）
            const rand = Utils.seededRandom(tid);
            const styleIdx = Math.floor(rand() * 10) + 1; // 1-10
            
            // 提取 Emoji
            const emojiMatch = title.match(/(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
            const emoji = emojiMatch ? emojiMatch[0] : null;
            
            // 处理摘要文本（关键词高亮）
            const processedExcerpt = this.processText(excerpt, tid, cfg);
            const primaryEmoji = Utils.getPrimaryCategoryEmoji(categoryHref, category);
            const categoryLabel = category ? (primaryEmoji ? `${primaryEmoji} ${category}` : category) : '';
            const watermarkEmoji = (primaryEmoji || (emoji ? emoji : '✦')).trim();
            const coverStyle = this._resolveCoverStyleForTopic(tid, cfg);
            const textCoverStyleClass = coverStyle === 'classic' ? '' : ` xhs-text-cover-${coverStyle}`;
            const styleSizeClass = this._getTextCoverSizeClass(coverStyle, excerpt);
            const showCoverPills = Boolean(cfg.coverPillsEnabled);
            const tagPillsHtml = showCoverPills ? tagNames.slice(0, 4).map((t) => `<span class="xhs-tag-pill" data-tag-name="${Utils.escapeHtml(t)}" title="跳转到标签：${Utils.escapeHtml(t)}">#${Utils.escapeHtml(t)}</span>`).join('') : '';
            const extraTags = showCoverPills && tagNames.length > 4 ? `+${tagNames.length - 4}` : '';
            const decoLayersHtml = this._generateTextCoverLayers(tid, watermarkEmoji, coverStyle);
            const unreadDisplay = unreadText || Utils.formatNumber(unreadNum);
            let stickerText = '';
            let stickerIsUnread = false;
            if (cfg.stickerEnabled) {
                if (cfg.showUnreadPosts && unreadNum > 0) {
                    stickerText = `未读 ${unreadDisplay}`;
                    stickerIsUnread = true;
                } else {
                    stickerText = this._pickTextCoverSticker(tid, {
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
                }
            }
            const coverRand = Utils.seededRandom(tid + '_cover2');
            const useDropcap = coverStyle === 'classic' && coverRand() < 0.42 && !emoji;
            const coverHidden = Config.isCoverHidden(tid);
            const coverOverrideStyle = Config.getCoverStyleOverride(tid);
            const coverStyleBadge = this._getCoverStyleBadge(coverStyle);
            const styleSourceText = coverOverrideStyle ? '已固定' : '跟随全局';
            const coverToggleTip = `封面选项（当前${coverHidden ? '仅文字' : '主楼图'}，样式${coverStyleBadge.name}，${styleSourceText}）`;
            const coverMenuHtml = `
                <div class="xhs-cover-toggle-menu" role="menu" aria-label="封面选项">
                    <span class="xhs-cover-toggle-item xhs-cover-toggle-item-mode${coverHidden ? ' is-active' : ''}" role="button" tabindex="0" data-action="cover-menu-toggle" data-tid="${Utils.escapeHtml(tid)}" aria-pressed="${coverHidden ? 'true' : 'false'}">${coverHidden ? '主图' : '仅文'}</span>
                    <span class="xhs-cover-toggle-item${coverOverrideStyle === 'classic' ? ' is-active' : ''}${coverStyle === 'classic' ? ' is-current' : ''}" role="button" tabindex="0" data-action="cover-menu-style" data-style="classic" data-tid="${Utils.escapeHtml(tid)}" aria-pressed="${coverOverrideStyle === 'classic' ? 'true' : 'false'}">经</span>
                    <span class="xhs-cover-toggle-item${coverOverrideStyle === 'notebook' ? ' is-active' : ''}${coverStyle === 'notebook' ? ' is-current' : ''}" role="button" tabindex="0" data-action="cover-menu-style" data-style="notebook" data-tid="${Utils.escapeHtml(tid)}" aria-pressed="${coverOverrideStyle === 'notebook' ? 'true' : 'false'}">笔</span>
                    <span class="xhs-cover-toggle-item${coverOverrideStyle === 'glass' ? ' is-active' : ''}${coverStyle === 'glass' ? ' is-current' : ''}" role="button" tabindex="0" data-action="cover-menu-style" data-style="glass" data-tid="${Utils.escapeHtml(tid)}" aria-pressed="${coverOverrideStyle === 'glass' ? 'true' : 'false'}">玻</span>
                    <span class="xhs-cover-toggle-item${coverOverrideStyle === 'collage' ? ' is-active' : ''}${coverStyle === 'collage' ? ' is-current' : ''}" role="button" tabindex="0" data-action="cover-menu-style" data-style="collage" data-tid="${Utils.escapeHtml(tid)}" aria-pressed="${coverOverrideStyle === 'collage' ? 'true' : 'false'}">贴</span>
                    <span class="xhs-cover-toggle-item${!coverOverrideStyle ? ' is-active' : ''}" role="button" tabindex="0" data-action="cover-menu-style" data-style="auto" data-tid="${Utils.escapeHtml(tid)}" aria-pressed="${!coverOverrideStyle ? 'true' : 'false'}">跟</span>
                </div>
            `;

            const coverHtml = `
                <div class="xhs-cover">
                    <div class="xhs-text-cover s${styleIdx}${textCoverStyleClass}${styleSizeClass}">
                        ${decoLayersHtml}
                        ${emoji ? `<div class="xhs-emoji-icon">${emoji}</div>` : ''}
                        <div class="xhs-text-excerpt ${useDropcap ? 'dropcap' : ''}">${processedExcerpt}</div>
                    </div>
                    ${(showCoverPills && (categoryLabel || tagPillsHtml)) ? `
                        <div class="xhs-category-bar">
                            ${categoryLabel ? `<span class="xhs-cat-pill" data-category-href="${Utils.escapeHtml(categoryHref || '')}" title="跳转到分类">${Utils.escapeHtml(categoryLabel)}</span>` : ''}
                            ${tagPillsHtml}
                            ${extraTags ? `<span class="xhs-tag-pill">${Utils.escapeHtml(extraTags)}</span>` : ''}
                        </div>
                    ` : ''}
                    ${pinned ? `<span class="xhs-pin">📌</span>` : ''}
                    ${featuredDomain ? `<span class="xhs-link-badge">🔗 ${Utils.escapeHtml(featuredDomain)}</span>` : ''}
                    ${stickerText ? `<span class="xhs-sticker${stickerIsUnread ? ' xhs-sticker-unread' : ''}">${Utils.escapeHtml(stickerText)}</span>` : ''}
                    <span class="xhs-cover-toggle${coverHidden ? ' is-hidden' : ''}" role="button" tabindex="0" data-action="toggle-cover" data-tid="${Utils.escapeHtml(tid)}" aria-pressed="false" aria-label="${Utils.escapeHtml(coverToggleTip)}" title="${Utils.escapeHtml(coverToggleTip)}">${coverHidden ? '🙈' : '🖼️'}</span>
                    ${coverMenuHtml}
                </div>
            `;

            const safeTitle = Utils.escapeHtml(title || '');
            const safeUser = Utils.escapeHtml(user || '');
            const safeUserCard = Utils.escapeHtml(userCard || '');
            const safeUserHref = Utils.escapeHtml(userHref || '');
            const safeAvatar = Utils.escapeHtml(avatar || '');
            const safeLastActivity = Utils.escapeHtml(lastActivity || '');
            const safeLastActivityTitle = Utils.escapeHtml(lastActivityTitle || '');
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
                        <span class="xhs-last-activity" ${safeLastActivityTitle ? `title="${safeLastActivityTitle}"` : ''}>${safeLastActivity}</span>
                        <div class="xhs-stats">
                            <span class="xhs-stat-item xhs-likes">❤️ <span class="xhs-like-count">-</span></span>
                            <a class="xhs-replies xhs-replies-link" href="/t/topic/${Utils.escapeHtml(tid)}/1" aria-label="${Utils.escapeHtml(String(replyNum))} 条回复，跳转到第一个帖子">💬 ${Utils.escapeHtml(repliesDisplay)}</a>
                            <span class="xhs-views">👁️ ${Utils.escapeHtml(viewsDisplay)}</span>
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

            // 回复数跳转：走站内导航，避免整页刷新
            const repliesLink = card.querySelector('.xhs-replies-link');
            if (repliesLink) {
                repliesLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    const u = repliesLink.getAttribute('href') || '';
                    if (!u || u === '#') return;
                    Utils.navigateTo(u);
                }, true);
            }

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

            const coverToggle = card.querySelector('.xhs-cover-toggle[data-action="toggle-cover"]');
            if (coverToggle) {
                const handleCoverMenuToggle = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    card.classList.toggle('xhs-cover-menu-open');
                    this.applyCoverPreferenceToCard(card);
                };
                coverToggle.addEventListener('click', handleCoverMenuToggle, true);
                coverToggle.addEventListener('keydown', (e) => {
                    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
                    handleCoverMenuToggle(e);
                }, true);
                card.addEventListener('mouseleave', () => {
                    if (!card.classList.contains('xhs-cover-menu-open')) return;
                    card.classList.remove('xhs-cover-menu-open');
                    this.applyCoverPreferenceToCard(card);
                });
            }

            const coverMenuToggle = card.querySelector('.xhs-cover-toggle-item[data-action="cover-menu-toggle"]');
            if (coverMenuToggle) {
                const handleCoverModeToggle = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    const key = String(tid || '').trim();
                    if (!key) return;
                    const nowHidden = Config.isCoverHidden(key);
                    if (nowHidden) Config.unsetCoverHidden(key);
                    else Config.setCoverHidden(key, card.dataset.title || title || `话题 ${key}`);
                    const nextHidden = !nowHidden;
                    const selector = `.xhs-card[data-tid="${CSS.escape(key)}"]`;
                    document.querySelectorAll(selector).forEach((cardItem) => {
                        cardItem.classList.remove('xhs-cover-menu-open');
                        this.applyCoverPreferenceToCard(cardItem);
                        if (!nextHidden) {
                            const cached = this.cache.get(key);
                            if (!cached || cached.needsImage) {
                                this.queue.push({ el: cardItem, tid: key });
                                this.processQueue();
                            }
                        }
                    });
                };
                coverMenuToggle.addEventListener('click', handleCoverModeToggle, true);
                coverMenuToggle.addEventListener('keydown', (e) => {
                    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
                    handleCoverModeToggle(e);
                }, true);
            }
            card.querySelectorAll('.xhs-cover-toggle-item[data-action="cover-menu-style"][data-style]').forEach((menuItem) => {
                const handleCoverStyleSet = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    const key = String(tid || '').trim();
                    if (!key) return;
                    const nextStyle = String(menuItem.getAttribute('data-style') || '').trim();
                    if (nextStyle === 'auto') Config.unsetCoverStyleOverride(key);
                    else Config.setCoverStyleOverride(key, nextStyle);
                    if (!Config.isCoverHidden(key)) {
                        Config.setCoverHidden(key, card.dataset.title || title || `话题 ${key}`);
                    }
                    const selector = `.xhs-card[data-tid="${CSS.escape(key)}"]`;
                    document.querySelectorAll(selector).forEach((cardItem) => {
                        cardItem.classList.remove('xhs-cover-menu-open');
                        this.applyCoverPreferenceToCard(cardItem);
                    });
                };
                menuItem.addEventListener('click', handleCoverStyleSet, true);
                menuItem.addEventListener('keydown', (e) => {
                    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
                    handleCoverStyleSet(e);
                }, true);
            });

            this.applyCoverPreferenceToCard(card);
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

            const cfg = Config.get();
            const tagNames = String(el.dataset?.tags || '').split('\n').map((t) => t.trim()).filter(Boolean);
            const pinned = String(el.dataset?.pinned || '') === '1';
            const featuredDomain = String(el.dataset?.featuredDomain || '');
            const categoryName = String(el.dataset?.categoryName || '');
            const replyNum = Utils.parseCount(el.dataset?.replyNum);
            const viewNum = Utils.parseCount(el.dataset?.viewNum);
            const categoryLabel = categoryName;

            const existing = cover.querySelector('.xhs-sticker');
            if (!cfg.stickerEnabled) {
                existing?.remove();
                return;
            }

            const unreadPosts = cfg.showUnreadPosts ? Utils.parseCount(el.dataset?.unreadPosts) : 0;
            let text = '';
            let isUnread = false;
            if (cfg.showUnreadPosts && unreadPosts > 0) {
                text = `未读 ${Utils.formatNumber(unreadPosts)}`;
                isUnread = true;
            } else {
                text = this._pickTextCoverSticker(tid, {
                    pinned,
                    tagNames,
                    featuredDomain,
                    categoryName,
                    categoryLabel,
                    replyNum,
                    viewNum,
                    likes: Number(likesOverride) || 0
                });
            }

            if (!text) {
                existing?.remove();
                return;
            }
            if (existing) {
                existing.textContent = text;
                existing.classList.toggle('xhs-sticker-unread', isUnread);
                return;
            }
            const sticker = document.createElement('span');
            sticker.className = `xhs-sticker${isUnread ? ' xhs-sticker-unread' : ''}`;
            sticker.textContent = text;
            cover.appendChild(sticker);
        },

        _resolveTextCoverStyle(styleMode, seed, mixPool) {
            const mode = String(styleMode || 'classic').trim();
            const singles = new Set(['classic', 'notebook', 'glass', 'collage']);
            if (singles.has(mode)) return mode;
            if (mode === 'mix_custom') {
                const pool = Config.normalizeTextCoverMixPool(mixPool);
                const rand = Utils.seededRandom(`${seed || ''}_cover_style_mix`);
                const idx = Math.floor(rand() * pool.length);
                return pool[idx] || 'classic';
            }

            return 'classic';
        },

        _getTextCoverSizeClass(style, excerpt) {
            const len = (excerpt || '').length;
            if (style === 'notebook') return len >= 64 ? ' xhs-text-cover-notebook-tall' : ' xhs-text-cover-notebook-normal';
            if (style === 'glass') return len >= 66 ? ' xhs-text-cover-glass-tall' : ' xhs-text-cover-glass-normal';
            if (style === 'collage') return len >= 58 ? ' xhs-text-cover-collage-tall' : ' xhs-text-cover-collage-normal';
            return '';
        },

        _generateTextCoverLayers(seed, watermarkEmoji, style) {
            const rand = Utils.seededRandom(seed + '_cover');
            const coverStyle =
                (
                    style === 'classic' ||
                    style === 'notebook' ||
                    style === 'glass' ||
                    style === 'collage'
                )
                    ? style
                    : 'classic';
            let html = '';

            const pat1 = this.bgPatterns[Math.floor(rand() * this.bgPatterns.length)];
            html += `<span class="xhs-bg ${pat1}"></span>`;
            const secondaryProb = coverStyle === 'classic'
                ? 0.35
                : (
                    coverStyle === 'glass' ? 0.16 : (coverStyle === 'collage' ? 0.08 : 0.12)
                );
            if (rand() < secondaryProb) {
                const pat2 = this.bgPatterns[Math.floor(rand() * this.bgPatterns.length)];
                html += `<span class="xhs-bg secondary ${pat2}"></span>`;
            }

            const quoteProb = coverStyle === 'classic'
                ? 0.35
                : (coverStyle === 'glass' ? 0.14 : (coverStyle === 'collage' ? 0.04 : 0.16));
            if (rand() < quoteProb) {
                html += `<span class="xhs-deco quote tl">“</span><span class="xhs-deco quote br">”</span>`;
            }

            const band1Prob = coverStyle === 'classic'
                ? 0.40
                : (coverStyle === 'notebook' ? 0.12 : (coverStyle === 'collage' ? 0.03 : 0.10));
            const band2Prob = coverStyle === 'classic'
                ? 0.22
                : (coverStyle === 'collage' ? 0.02 : 0.08);
            if (rand() < band1Prob) html += `<span class="xhs-deco band b1"></span>`;
            if (rand() < band2Prob) html += `<span class="xhs-deco band b2"></span>`;

            const tape1Prob = coverStyle === 'classic'
                ? 0.28
                : (coverStyle === 'glass' ? 0.02 : (coverStyle === 'collage' ? 0.0 : 0.05));
            const tape2Prob = coverStyle === 'classic'
                ? 0.18
                : (coverStyle === 'glass' ? 0.01 : (coverStyle === 'collage' ? 0.0 : 0.03));
            if (rand() < tape1Prob) html += `<span class="xhs-deco tape t1"></span>`;
            if (rand() < tape2Prob) html += `<span class="xhs-deco tape t2"></span>`;

            const corners = ['tl', 'tr', 'bl', 'br'];
            const r = rand();
            let cornerCount;
            if (coverStyle === 'classic') {
                if (r < 0.05) cornerCount = 0;
                else if (r < 0.15) cornerCount = 1;
                else if (r < 0.50) cornerCount = 2;
                else if (r < 0.85) cornerCount = 3;
                else cornerCount = 4;
            } else if (coverStyle === 'glass') {
                if (r < 0.20) cornerCount = 0;
                else if (r < 0.84) cornerCount = 1;
                else cornerCount = 2;
            } else if (coverStyle === 'collage') {
                if (r < 0.15) cornerCount = 1;
                else if (r < 0.78) cornerCount = 2;
                else cornerCount = 3;
            } else if (coverStyle === 'notebook') {
                if (r < 0.15) cornerCount = 0;
                else if (r < 0.70) cornerCount = 1;
                else cornerCount = 2;
            } else {
                if (r < 0.22) cornerCount = 0;
                else if (r < 0.75) cornerCount = 1;
                else cornerCount = 2;
            }
            const pickedCorners = [...corners].sort(() => rand() - 0.5).slice(0, cornerCount);
            for (const pos of pickedCorners) {
                const deco = this.cornerDecos[Math.floor(rand() * this.cornerDecos.length)];
                html += `<span class="xhs-deco corner ${pos}">${deco}</span>`;
            }

            let lineCount;
            if (coverStyle === 'classic') {
                lineCount = rand() < 0.62 ? 1 : (rand() < 0.28 ? 2 : 0);
            } else if (coverStyle === 'notebook') {
                lineCount = rand() < 0.74 ? 1 : (rand() < 0.18 ? 2 : 0);
            } else if (coverStyle === 'collage') {
                lineCount = 0;
            } else {
                lineCount = rand() < 0.42 ? 1 : 0;
            }
            const linePositions = ['line-t', 'line-b'];
            for (let i = 0; i < lineCount; i++) {
                const ch = this.lineChars[Math.floor(rand() * this.lineChars.length)];
                const count = 5 + Math.floor(rand() * 7);
                const pos = linePositions[i % linePositions.length];
                html += `<span class="xhs-deco line ${pos}">${ch.repeat(count)}</span>`;
            }

            const posIdx = coverStyle === 'glass'
                ? (Math.floor(rand() * 2) + 1)
                : (coverStyle === 'collage' ? (Math.floor(rand() * 2) + 2) : (Math.floor(rand() * 4) + 1));
            html += `<span class="xhs-deco big p${posIdx}">${Utils.escapeHtml(watermarkEmoji || '✦')}</span>`;

            return html;
        },

        _getKeywordRegex(keywords) {
            const arr = Array.isArray(keywords) ? keywords : [];
            const key = arr.join('\u0001');
            if (this.keywordRegexCache?.key === key) return this.keywordRegexCache.regex;
            let regex = null;
            if (arr.length) {
                const escaped = arr
                    .map((word) => Utils.escapeRegExp(word))
                    .filter(Boolean)
                    .sort((a, b) => b.length - a.length);
                if (escaped.length) {
                    try { regex = new RegExp(escaped.join('|'), 'giu'); } catch { regex = null; }
                }
            }
            this.keywordRegexCache = { key, regex };
            return regex;
        },

        _pickKeywordHighlightClass(styleMode, rand) {
            const mode = Config.normalizeKeywordHighlightStyle(styleMode);
            if (mode === 'random') {
                const styles = ['xhs-hl', 'xhs-ul', 'xhs-wave', 'xhs-dot', 'xhs-bd'];
                return styles[Math.floor(rand() * styles.length)] || 'xhs-hl';
            }
            const map = {
                hl: 'xhs-hl',
                ul: 'xhs-ul',
                wave: 'xhs-wave',
                dot: 'xhs-dot',
                bd: 'xhs-bd'
            };
            return map[mode] || 'xhs-hl';
        },

        processText(text, seed, cfg) {
            const raw = String(text || '');
            if (!raw) return '';
            const currentCfg = cfg || Config.get();
            if (!currentCfg.keywordHighlightEnabled) return Utils.escapeHtml(raw);
            const keywords = Config.normalizeKeywordHighlightLexicon(currentCfg.keywordHighlightLexicon);
            if (!keywords.length) return Utils.escapeHtml(raw);

            const keywordRegex = this._getKeywordRegex(keywords);
            if (!keywordRegex) return Utils.escapeHtml(raw);

            const rand = Utils.seededRandom(`${seed || ''}_keyword`);
            let lastIndex = 0;
            let out = '';
            let hit = false;
            keywordRegex.lastIndex = 0;
            raw.replace(keywordRegex, (match, offset) => {
                const index = Number(offset) || 0;
                if (index > lastIndex) out += Utils.escapeHtml(raw.slice(lastIndex, index));
                const cls = this._pickKeywordHighlightClass(currentCfg.keywordHighlightStyle, rand);
                out += `<span class="${cls}">${Utils.escapeHtml(match)}</span>`;
                lastIndex = index + match.length;
                hit = true;
                return match;
            });
            if (!hit) return Utils.escapeHtml(raw);
            if (lastIndex < raw.length) out += Utils.escapeHtml(raw.slice(lastIndex));
            return out;
        }
    };

    /* ============================================
     * 5. 帖子页滚动稳定（向上加载不跳楼）
     * ============================================ */
    const TopicScroll = {
        enabled: false,
        observer: null,
        observerTarget: null,
        attachTimer: null,
        freezeUntil: 0,
        lastFirstPostNumber: null,
        anchor: null,
        scrollRaf: 0,
        adjustTimer: null,
        adjustRaf: 0,
        adjustTriesLeft: 0,
        _boundOnScroll: null,

        _getPostStream() {
            return document.querySelector('.post-stream');
        },

        _getFirstPostNumber() {
            const first = document.querySelector('.topic-post[data-post-number]');
            const n = parseInt(first?.getAttribute?.('data-post-number') || '', 10);
            return Number.isFinite(n) ? n : null;
        },

        _pickAnchor() {
            const posts = Array.from(document.querySelectorAll('.topic-post[data-post-number]'));
            const vh = window.innerHeight || 0;
            if (!posts.length || !vh) return null;

            // 尽量对齐 Discourse 的阅读体验：用一个“视口上方偏移”的 anchor 线
            const anchorY = Math.min(180, Math.max(64, Math.round(vh * 0.18)));
            const visible = [];
            for (const p of posts) {
                const r = p.getBoundingClientRect();
                if (r.bottom <= 0 || r.top >= vh) continue;
                visible.push({ el: p, top: r.top, bottom: r.bottom });
            }
            if (!visible.length) return null;
            visible.sort((a, b) => a.top - b.top);

            const hit = visible.find((v) => v.top <= anchorY && v.bottom >= anchorY) || visible[0];
            const postNumber = parseInt(hit.el.getAttribute('data-post-number') || '', 10);
            if (!Number.isFinite(postNumber)) return null;
            return { postNumber, top: hit.top };
        },

        captureAnchor() {
            const picked = this._pickAnchor();
            if (!picked) return;
            this.anchor = picked;
        },

        _scheduleCapture() {
            if (this.scrollRaf) return;
            this.scrollRaf = requestAnimationFrame(() => {
                this.scrollRaf = 0;
                if (!this.enabled) return;
                if (Date.now() < (this.freezeUntil || 0)) return;
                try { this.captureAnchor(); } catch {}
            });
        },

        _adjustOnce() {
            const anchor = this.anchor;
            if (!anchor || !Number.isFinite(anchor.postNumber)) return true;
            const el = document.querySelector(`.topic-post[data-post-number="${String(anchor.postNumber)}"]`);
            if (!el) return true;
            const top = el.getBoundingClientRect().top;
            const delta = top - anchor.top;
            if (!Number.isFinite(delta) || Math.abs(delta) < 6) return true;
            try { window.scrollBy(0, delta); } catch { return true; }
            return false;
        },

        _scheduleAdjust() {
            if (this.adjustTimer || this.adjustRaf) return;
            this.adjustTriesLeft = 3;
            this.adjustTimer = setTimeout(() => {
                this.adjustTimer = null;

                const step = () => {
                    this.adjustRaf = 0;
                    if (!this.enabled) return;

                    const done = this._adjustOnce();
                    this.adjustTriesLeft -= 1;

                    if (!done && this.adjustTriesLeft > 0) {
                        this.adjustRaf = requestAnimationFrame(step);
                        return;
                    }

                    try { this.captureAnchor(); } catch {}
                };

                this.adjustRaf = requestAnimationFrame(step);
            }, 0);
        },

        _onMutations() {
            if (!this.enabled) return;

            const prevFirst = this.lastFirstPostNumber;
            const nextFirst = this._getFirstPostNumber();
            this.lastFirstPostNumber = nextFirst;

            // 仅处理“向上加载更多”场景：首个楼层号变小
            if (prevFirst !== null && nextFirst !== null && nextFirst < prevFirst) {
                // DOM/scroll 会在短时间内持续抖动：冻结 anchor 更新，等稳定后再校正滚动
                this.freezeUntil = Date.now() + 500;
                this._scheduleAdjust();
            }
        },

        _ensureObserver() {
            if (!this.enabled) return;

            const stream = this._getPostStream();
            if (!stream) {
                clearTimeout(this.attachTimer);
                this.attachTimer = setTimeout(() => this._ensureObserver(), 500);
                return;
            }
            if (this.observer && this.observerTarget === stream) return;

            try { this.observer?.disconnect?.(); } catch {}
            this.observer = null;
            this.observerTarget = stream;
            this.lastFirstPostNumber = this._getFirstPostNumber();

            this.observer = new MutationObserver(() => this._onMutations());
            try { this.observer.observe(stream, { childList: true }); } catch {}
        },

        start() {
            if (this.enabled) return;
            this.enabled = true;
            this.freezeUntil = 0;
            this.anchor = null;
            this.lastFirstPostNumber = this._getFirstPostNumber();

            this._boundOnScroll = () => {
                if (!this.enabled) return;
                if (Date.now() < (this.freezeUntil || 0)) return;
                this._scheduleCapture();
            };
            window.addEventListener('scroll', this._boundOnScroll, { passive: true });

            try { this.captureAnchor(); } catch {}
            this._ensureObserver();
        },

        stop() {
            if (!this.enabled) return;
            this.enabled = false;

            try { window.removeEventListener('scroll', this._boundOnScroll); } catch {}
            this._boundOnScroll = null;

            try { this.observer?.disconnect?.(); } catch {}
            this.observer = null;
            this.observerTarget = null;
            clearTimeout(this.attachTimer);
            this.attachTimer = null;
            clearTimeout(this.adjustTimer);
            this.adjustTimer = null;
            if (this.scrollRaf) { try { cancelAnimationFrame(this.scrollRaf); } catch {} }
            this.scrollRaf = 0;
            if (this.adjustRaf) { try { cancelAnimationFrame(this.adjustRaf); } catch {} }
            this.adjustRaf = 0;
            this.adjustTriesLeft = 0;
            this.freezeUntil = 0;
            this.anchor = null;
            this.lastFirstPostNumber = null;
        },

        update() {
            const cfg = Config.get();
            const shouldEnable = Boolean(cfg.enabled && cfg.topicScrollKeepPosition && Utils.isTopicPath());
            if (!shouldEnable) {
                this.stop();
                return;
            }
            if (!this.enabled) this.start();
            this._ensureObserver();
        }
    };

    /* ============================================
     * 6. 主程序
     * ============================================ */
    const App = {
        _scrollLock: null,

        _lockPageScroll() {
            if (this._scrollLock) return;
            try {
                const root = document.documentElement;
                const body = document.body;
                const scrollbarW = Math.max(0, (window.innerWidth || 0) - (root?.clientWidth || 0));
                this._scrollLock = {
                    rootOverflow: root?.style?.overflow || '',
                    bodyOverflow: body?.style?.overflow || '',
                    bodyPaddingRight: body?.style?.paddingRight || '',
                    scrollbarW
                };
                if (root) root.style.overflow = 'hidden';
                if (body) {
                    body.style.overflow = 'hidden';
                    if (scrollbarW > 0) body.style.paddingRight = `${scrollbarW}px`;
                }
            } catch {}
        },

        _unlockPageScroll() {
            const s = this._scrollLock;
            if (!s) return;
            this._scrollLock = null;
            try {
                const root = document.documentElement;
                const body = document.body;
                if (root) root.style.overflow = s.rootOverflow;
                if (body) {
                    body.style.overflow = s.bodyOverflow;
                    body.style.paddingRight = s.bodyPaddingRight;
                }
            } catch {}
        },

        openSettingsPanel() {
            const overlay = document.querySelector('.xhs-panel-overlay');
            const panel = overlay?.querySelector?.('.xhs-panel');
            if (!overlay || !panel) return;
            this._lockPageScroll();
            overlay.classList.add('show');
            panel.classList.add('show');
        },

        closeSettingsPanel() {
            const overlay = document.querySelector('.xhs-panel-overlay');
            const panel = overlay?.querySelector?.('.xhs-panel');
            overlay?.classList.remove('show');
            panel?.classList.remove('show');
            this._unlockPageScroll();
        },

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
                    Utils.saveLastListUrl();
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
                    Utils.saveLastListUrl();
                    Utils.saveListScrollState({ y: window.scrollY, tid });
                } catch {}
            }, true);
            // 点左上角 logo 返回：默认会去“/”，但用户更期望回到自己浏览的列表视图并恢复定位
            document.addEventListener('click', (e) => {
                try {
                    if (!Config.get().enabled) return;
                    // 仅在非列表页（如帖子页）拦截
                    if (Utils.isListLikePath()) return;
                    const a = e.target?.closest?.('a');
                    if (!a) return;
                    const href = a.getAttribute('href') || a.href || '';
                    if (!href) return;
                    const u = new URL(href, window.location.origin);
                    if (u.origin !== window.location.origin) return;
                    if (u.pathname !== '/' || (u.search || '')) return;
                    // 只拦截 header/logo 区域的“回首页”
                    if (!a.closest?.('.d-header')) return;
                    const last = Utils.loadLastListUrl();
                    if (!last || last === '/' ) return; // 没有历史列表或本来就是首页
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    Utils.navigateTo(last);
                } catch {}
            }, true);
            // “查看 xx 个新的或更新的话题”：点击后下一次渲染按最新顺序重排卡片
            document.addEventListener('click', (e) => {
                try {
                    if (!Config.get().enabled) return;
                    const btn = e.target?.closest?.('button, a');
                    const text = (btn?.textContent || '').trim();
                    if (!btn || !text) return;
                    if (text.includes('查看') && text.includes('新的') && text.includes('更新') && text.includes('话题')) {
                        Grid.forceReorderOnNextRender = true;
                        setTimeout(() => {
                            try { Grid.syncListNoticeSpacing(); } catch {}
                        }, 0);
                    }
                } catch {}
            }, true);

            // 应用配置
            this.applyConfig();
            // 观察 Discourse SPA 可能的 header 重渲染，确保设置按钮尽量固定在顶栏
            this.startHeaderObserver();
            this.startHeaderEnsureLoop();
            
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
                    if (document.body.classList.contains('xhs-on')) {
                        try { Grid.syncListNoticeSpacing(); } catch {}
                        return;
                    }
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
        headerBtnRetryTimer: null,
        headerBtnRetryCount: 0,
        headerBtnFirstAttemptAt: 0,
        headerObserver: null,
        headerObserverTimer: null,
        headerBtnLastEnsureAt: 0,
        headerEnsureInterval: null,
        headerEnsureStartedAt: 0,

        tryRenderListPage() {
            const cfg = Config.get();
            if (!cfg.enabled) return;
            if (!Utils.isListLikePath()) return;
            try { Utils.saveLastListUrl(); } catch {}

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
            document.body.classList.remove('xhs-active');
            document.querySelector('.xhs-grid')?.remove();
            Grid.container = null;
            // 回到列表页时，Discourse 可能复用旧的 row DOM；清掉处理标记，避免“有 grid 但无 cards”
            try {
                Utils.getTopicRows().forEach((row) => {
                    row.classList.remove('xhs-processed');
                    delete row.dataset.xhsProcessedTid;
                });
            } catch {}
            try {
                Grid.render();
            } catch {
                // 渲染失败时回退到原生列表，避免空白
                document.body.classList.remove('xhs-on');
                document.body.classList.remove('xhs-active');
                document.querySelector('.xhs-grid')?.remove();
                Grid.container = null;
                return;
            }
            // 仅当容器与卡片确实存在时才进入“active”状态（隐藏原生列表）
            try {
                const ok = Boolean(Grid.container && Grid.container.querySelector('.xhs-card'));
                document.body.classList.toggle('xhs-active', ok);
            } catch {}
            // 过加载模式切换后，需要重建 observer（避免 rootMargin 不生效）
            try { Grid.resetObserver(); } catch {}

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

            // SPA 路由切换时，顶部导航可能被重渲染：确保设置按钮仍在“搜索”左侧
            try { this.createFloatBtn(); } catch {}
            try { this.startHeaderObserver(); } catch {}
            try { this.startHeaderEnsureLoop(); } catch {}

            document.body.classList.remove('xhs-on');
            document.body.classList.remove('xhs-active');
            document.body.classList.remove('xhs-has-list-notice');
            document.documentElement.style.removeProperty('--xhs-list-notice-offset');
            this.pendingRenderRetryCount = 0;
            clearTimeout(this.pendingRenderRetryTimer);
            this.pendingRenderRetryTimer = null;
            this.headerBtnRetryCount = 0;
            clearTimeout(this.headerBtnRetryTimer);
            this.headerBtnRetryTimer = null;
            clearTimeout(this.headerObserverTimer);
            this.headerObserverTimer = null;
            try { Grid.coverRevalidatedInSession?.clear?.(); } catch {}
            if (!Utils.isListLikePath()) this.restoredForKey = '';

            if (Config.get().enabled) {
                // 只要是“列表类路径”，就尝试渲染；内部会等 rows 出现再真正生效。
                this.tryRenderListPage();
            }
            // 帖子页增强样式依赖 body class，这里在路由切换时也同步刷新一次
            try { this.applyTopicEnhance(); } catch {}
            try { TopicScroll.update(); } catch {}
        },

        applyTopicEnhance() {
            const cfg = Config.get();
            const ok = Boolean(cfg.enabled && Utils.isTopicPath());
            const isPrivateMessage = Utils.isPrivateMessageTopic();
            document.body.classList.remove('xhs-topic-reading');
            document.body.classList.toggle('xhs-topic-cards', ok && Boolean(cfg.topicReplyCards) && !isPrivateMessage);
        },

        startHeaderObserver() {
            try { this.headerObserver?.disconnect?.(); } catch {}
            this.headerObserver = null;
            clearTimeout(this.headerObserverTimer);
            this.headerObserverTimer = null;

            const attach = () => {
                try { this.headerObserver?.disconnect?.(); } catch {}
                this.headerObserver = null;
                const body = document.body;
                if (!body) {
                    this.headerObserverTimer = setTimeout(attach, 250);
                    return;
                }

                const ensure = Utils.debounce(() => {
                    try {
                        const now = Date.now();
                        if (now - (this.headerBtnLastEnsureAt || 0) < 250) return;
                        this.headerBtnLastEnsureAt = now;
                        const headerUl =
                            document.querySelector('ul.d-header-icons') ||
                            document.querySelector('.d-header-icons');
                        if (!headerUl || headerUl.tagName !== 'UL') return;
                        const inHeader = Boolean(document.querySelector('.d-header #xhs-settings-button'));
                        if (!inHeader) this.createFloatBtn();
                    } catch {}
                }, 160);

                this.headerObserver = new MutationObserver(() => ensure());
                this.headerObserver.observe(body, { childList: true, subtree: true });
                ensure();
            };

            attach();
        },

        startHeaderEnsureLoop() {
            try { clearInterval(this.headerEnsureInterval); } catch {}
            this.headerEnsureInterval = null;
            this.headerEnsureStartedAt = Date.now();

            this.headerEnsureInterval = setInterval(() => {
                try {
                    const started = this.headerEnsureStartedAt || 0;
                    if (started && (Date.now() - started) > 30000) {
                        clearInterval(this.headerEnsureInterval);
                        this.headerEnsureInterval = null;
                        return;
                    }
                    const headerUl =
                        document.querySelector('ul.d-header-icons') ||
                        document.querySelector('.d-header-icons');
                    if (!headerUl || headerUl.tagName !== 'UL') return;
                    const inHeader = Boolean(document.querySelector('.d-header #xhs-settings-button'));
                    if (!inHeader) this.createFloatBtn();
                } catch {}
            }, 800);
        },

        applyConfig() {
            const cfg = Config.get();
            EarlyStyles.cacheEnabled(cfg.enabled);
            try { Grid.applyRateLimitConfig(); } catch {}
            document.body.dataset.xhsShowStats = cfg.showStats ? '1' : '0';
            document.body.dataset.xhsMetaLayout = cfg.metaLayout || 'compact';
            document.body.dataset.xhsAuthorDisplay = cfg.authorDisplay || 'full';
            document.body.dataset.xhsStickerEnabled = cfg.stickerEnabled ? '1' : '0';
            document.body.dataset.xhsStatsAlign = cfg.statsAlign || 'left';
            document.body.dataset.xhsStatLastActivity = (cfg.showStats && cfg.showStatLastActivity) ? '1' : '0';
            document.body.dataset.xhsStatLikes = (cfg.showStats && cfg.showStatLikes) ? '1' : '0';
            document.body.dataset.xhsStatReplies = (cfg.showStats && cfg.showStatReplies) ? '1' : '0';
            document.body.dataset.xhsStatViews = (cfg.showStats && cfg.showStatViews) ? '1' : '0';
            document.body.dataset.xhsTextCoverStyle = cfg.textCoverStyle || 'classic';
            try { this.applyTopicEnhance(); } catch {}
            try { TopicScroll.update(); } catch {}
            // 设置按钮可能需要根据图标配置刷新
            try { this.createFloatBtn(); } catch {}
            
            if (cfg.enabled) {
                document.body.classList.remove('xhs-on');
                document.body.classList.remove('xhs-active');
                Styles.injectTheme();
                if (Utils.isListLikePath()) {
                    if (Grid.container) {
                        Grid.container.classList.toggle('grid-mode', !cfg.cardStagger);
                    }
                    this.tryRenderListPage();
                    try { Grid.syncListNoticeSpacing(); } catch {}
                }
            } else {
                document.body.classList.remove('xhs-on');
                document.body.classList.remove('xhs-active');
                document.body.classList.remove('xhs-has-list-notice');
                document.documentElement.style.removeProperty('--xhs-list-notice-offset');
                Styles.removeTheme();
                document.querySelector('.xhs-grid')?.remove();
                Grid.container = null;
            }

            // 早期防闪烁样式仅用于首屏，配置已应用后立即移除，避免影响其它页面（如消息页）。
            EarlyStyles.remove();
            // 预取范围可能变化：列表页尝试更新 observer 配置
            try { if (cfg.enabled && Utils.isListLikePath()) Grid.resetObserver(); } catch {}
            // 不强制重渲染列表：直接更新现有卡片的贴纸/未读状态
            try {
                if (cfg.enabled && Utils.isListLikePath()) {
                    document.querySelectorAll('.xhs-card[data-tid]').forEach((card) => {
                        const tid = String(card.getAttribute('data-tid') || '');
                        const likes = Utils.parseCount(card.querySelector('.xhs-like-count')?.textContent || '0');
                        const meta = Grid.listTopicMeta.get(tid) || { unreadPosts: Utils.parseCount(card.dataset?.unreadPosts) || 0 };
                        Grid.applyUnreadMetaToCard(card, meta);
                        Grid.updateStickerForCard(card, likes);
                        Grid.applyCoverPreferenceToCard(card);
                    });
                }
            } catch {}

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
                            textCoverStyle: Config.get().textCoverStyle || 'classic',
                            textCoverMixPool: Config.get().textCoverMixPool || [],
                            keywordHighlightEnabled: Boolean(Config.get().keywordHighlightEnabled),
                            keywordHighlightStyle: Config.get().keywordHighlightStyle || 'random',
                            keywordHighlightCount: Config.normalizeKeywordHighlightLexicon(Config.get().keywordHighlightLexicon).length,
                            overfetchMode: Boolean(Config.get().overfetchMode),
                            imgCropEnabled: Boolean(Config.get().imgCropEnabled),
                            imgCropBaseRatio: Number(Config.get().imgCropBaseRatio) || 0,
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
            // 防止多次快速调用导致重复 schedule
            clearTimeout(this.headerBtnRetryTimer);
            this.headerBtnRetryTimer = null;
            try { this.headerBtnLastEnsureAt = Date.now(); } catch {}
            if (!this.headerBtnFirstAttemptAt) this.headerBtnFirstAttemptAt = Date.now();

            // 先清理旧按钮（避免 SPA 重渲染/回退导致重复）
            try { document.querySelector('.xhs-settings-dropdown')?.remove?.(); } catch {}
            try { document.querySelector('.xhs-float-btn.xhs-float-fixed')?.remove?.(); } catch {}
            try { document.querySelector('.xhs-float-btn.xhs-float-header')?.closest?.('li')?.remove?.(); } catch {}

            const cfg = Config.get();

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn no-text btn-icon icon btn-flat xhs-float-btn xhs-float-header';
            btn.id = 'xhs-settings-button';
            btn.title = '小水书设置';
            btn.setAttribute('aria-label', '小水书设置');
            try { btn.style.setProperty('--xhs-settings-icon-size', `${Number(cfg.settingsIconSize) || 20}px`); } catch {}
            if (cfg.settingsIconStyle === 'xhsText') {
                const t = Utils.escapeHtml(cfg.settingsIconXhsText || '小水书');
                const c1 = Utils.escapeHtml(cfg.settingsIconGradientTop || '#33CCFF');
                const c2 = Utils.escapeHtml(cfg.settingsIconGradientBottom || '#0066CC');
                const scale = Number(cfg.settingsIconTextScale) || 1.0;
                const gid = `xhsWaterGradient_${Math.random().toString(36).slice(2)}`;
                const fontSize = Math.round(560 * scale);
                const strokeWidth = Math.max(10, Math.round(22 * scale));
                const letterSpacing = Math.round(-22 * scale);
                btn.innerHTML = `
                    <svg viewBox="0 0 1699 1024" aria-hidden="true" focusable="false">
                      <defs>
                        <linearGradient id="${gid}" x1="0%" y1="0%" x2="0%" y2="100%">
                          <stop offset="0%" stop-color="${c1}" stop-opacity="1"></stop>
                          <stop offset="100%" stop-color="${c2}" stop-opacity="1"></stop>
                        </linearGradient>
                      </defs>
                      <text x="50%" y="58%" text-anchor="middle" dominant-baseline="middle"
                        font-size="${fontSize}" font-weight="900"
                        font-family="'PingFang SC','Heiti SC','Microsoft YaHei','Arial Black',sans-serif"
                        fill="url(#${gid})" letter-spacing="${letterSpacing}"
                        stroke="url(#${gid})" stroke-width="${strokeWidth}" stroke-linejoin="round"
                      >${t}</text>
                    </svg>
                `;
            } else if (cfg.settingsIconStyle === 'grid') {
                const gridColor = Utils.escapeHtml(String(cfg.settingsIconGridColor || '#B5B5B5'));
                try { btn.style.setProperty('--xhs-settings-icon-color', gridColor); } catch {}
                btn.innerHTML = `
                    <svg viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
                      <path d="M870.4 32.023273c49.477818 0 89.6 40.075636 89.6 89.6v780.753454a89.6 89.6 0 0 1-89.6 89.6H153.6a89.6 89.6 0 0 1-89.6-89.6V121.623273c0-49.524364 40.122182-89.6 89.6-89.6h716.8zM239.662545 121.483636L153.6 121.576727v780.8h86.062545V121.483636z m630.737455 0.046546h-57.623273v176.034909a97.140364 97.140364 0 0 1-139.636363 87.365818l-7.726546-4.235636-33.419636-20.200728a44.823273 44.823273 0 0 0-40.634182-2.932363l-5.492364 2.792727-34.350545 20.48A98.071273 98.071273 0 0 1 403.549091 305.431273l-0.372364-8.843637-0.046545-175.010909H329.262545v780.8H870.4V121.623273z m-358.353455 601.506909l192 0.232727a44.823273 44.823273 0 0 1 5.12 89.274182l-5.21309 0.325818-192-0.232727a44.823273 44.823273 0 0 1 0.09309-89.6z m0-159.883636l192 0.186181a44.823273 44.823273 0 0 1 5.12 89.320728l-5.21309 0.279272-192-0.186181a44.823273 44.823273 0 0 1 0.09309-89.6z m211.130182-441.669819h-230.4v175.104a8.471273 8.471273 0 0 0 10.333091 8.285091l2.513455-1.024 34.397091-20.48a134.423273 134.423273 0 0 1 129.675636-4.328727l8.610909 4.794182 33.419636 20.154182a7.540364 7.540364 0 0 0 11.077819-4.049455l0.372363-2.373818V121.483636z" fill="${gridColor}"></path>
                    </svg>
                `;
            } else {
                const gearColor = Utils.escapeHtml(String(cfg.settingsIconGearColor || '#BDBDBD'));
                btn.innerHTML = `
                    <svg viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
                      <path d="M512 320c-105.9 0-192 86.1-192 192s86.1 192 192 192 192-86.1 192-192-86.1-192-192-192z m0 298.7c-58.8 0-106.7-47.9-106.7-106.7S453.2 405.3 512 405.3 618.7 453.2 618.7 512 570.8 618.7 512 618.7z" fill="${gearColor}"></path>
                      <path d="M901.6 514.6l42.5-73.7c15.9-27.5 18.7-60.4 7.8-90.3-17.7-48.7-43.4-93.8-76.2-134.1-20.4-25.1-50.6-39.4-83-39.4h-86L662.9 101c-16.1-28-43.8-47-76-52.2-48.6-8-99.9-8.2-149.5-0.3-32.3 5.1-60.1 24.2-76.3 52.3L317.2 177h-87.5c-32.4 0-62.6 14.4-83 39.5-32.3 39.8-57.7 84.1-75.4 131.7-11.2 30.1-8.4 63.2 7.6 91l43.5 75.4L80 588c-16.1 28-18.8 61.5-7.2 91.8 18.6 48.9 45.3 94.1 79.2 134.2 20.5 24.2 50.3 38.1 81.9 38.1h83.3l40.9 70.7c16 27.7 43.5 46.7 75.5 52.1 25.5 4.3 51.5 6.5 77.6 6.5 27.1 0 54.4-2.4 81-7 31.1-5.5 58.1-24.4 74-51.9l40.6-70.3h81.8c31.6 0 61.4-13.9 81.9-38.1 34.5-40.8 61.4-86.7 80-136.5 11.3-30.2 8.5-63.5-7.5-91.2l-41.4-71.8z m-86.2 21.3l53.6 93c3.2 5.6 3.8 12.4 1.5 18.7-15.2 40.5-37.1 78-65.2 111.3-4.2 5-10.3 7.9-16.7 7.9H682.1c-15.2 0-29.3 8.1-37 21.3l-52.9 91.7c-3.2 5.6-8.6 9.4-14.8 10.5-42.7 7.5-87.2 7.6-129.6 0.5-6.8-1.1-12.5-5-15.8-10.6L378.8 788c-7.6-13.2-21.7-21.3-36.9-21.3h-108c-6.4 0-12.5-2.9-16.7-7.8-27.7-32.8-49.5-69.7-64.7-109.6-2.4-6.2-1.9-13.1 1.4-18.7l54.6-94.7c7.6-13.2 7.6-29.4 0-42.6l-55.8-96.7c-3.2-5.6-3.8-12.4-1.5-18.6 14.5-38.9 35.2-75.1 61.7-107.6 4.1-5.1 10.2-8 16.8-8h112.1c15.2 0 29.4-8.1 37-21.4l56.2-97.6c3.3-5.7 9-9.6 15.8-10.7 40.6-6.5 82.7-6.3 122.3 0.2 6.8 1.1 12.5 5 15.8 10.7L645 241c7.6 13.2 21.7 21.4 37 21.4h110.7c6.5 0 12.7 2.9 16.8 8 26.8 32.9 47.7 69.7 62.2 109.4 2.2 6.2 1.7 12.9-1.5 18.5l-54.9 95c-7.5 13.1-7.5 29.4 0.1 42.6z" fill="${gearColor}"></path>
                    </svg>
                `;
            }
            btn.addEventListener('click', (e) => {
                try { e.preventDefault?.(); } catch {}
                App.openSettingsPanel();
            }, true);

            // 优先插入到顶部导航：放在搜索按钮（magnifying-glass）左侧
            const searchLi =
                document.querySelector('.d-header-icons li.header-dropdown-toggle.search-dropdown') ||
                document.querySelector('#search-button')?.closest?.('li');
            const headerUl =
                document.querySelector('ul.d-header-icons') ||
                document.querySelector('.d-header-icons');
            if (headerUl && headerUl.tagName === 'UL') {
                const li = document.createElement('li');
                li.className = 'header-dropdown-toggle xhs-settings-dropdown';
                li.appendChild(btn);
                try {
                    if (searchLi && searchLi.parentElement === headerUl) headerUl.insertBefore(li, searchLi);
                    else headerUl.appendChild(li);
                    this.headerBtnRetryCount = 0;
                    this.headerBtnFirstAttemptAt = 0;
                    return;
                } catch {}
            }

            // Discourse SPA 里 header/icons 可能晚于脚本初始化渲染：
            // 默认先不显示右下角按钮，避免首屏闪现；若长时间仍无法插入顶栏，再兜底显示悬浮按钮。
            this.headerBtnRetryCount += 1;
            if (this.headerBtnRetryCount <= 40) {
                this.headerBtnRetryTimer = setTimeout(() => {
                    try { this.createFloatBtn(); } catch {}
                }, this.headerBtnRetryCount <= 16 ? 250 : 600);
            }

            const elapsed = Date.now() - (this.headerBtnFirstAttemptAt || Date.now());
            const shouldFallbackFixed = elapsed > 2500 && this.headerBtnRetryCount > 10;
            if (!shouldFallbackFixed) return;
            btn.classList.remove('xhs-float-header');
            btn.classList.add('xhs-float-fixed');
            document.body.appendChild(btn);
        },

        createPanel() {
            const overlay = document.createElement('div');
            overlay.className = 'xhs-panel-overlay';
            
            const panel = document.createElement('div');
            panel.className = 'xhs-panel';
            // 防止被主题/站点同名样式覆盖导致无法滚动（inline important 优先级最高）
            try {
                panel.style.setProperty('display', 'flex', 'important');
                panel.style.setProperty('flex-direction', 'column', 'important');
            } catch {}
            
            const render = () => {
                const prevScrollTop = (() => {
                    try { return panel.querySelector('.xhs-panel-body')?.scrollTop || 0; } catch { return 0; }
                })();
                const cfg = Config.get();
                const hiddenCoverEntries = Object.entries(cfg.hiddenCoverTopics || {})
                    .map(([tid, t]) => [String(tid), String(t || '').trim()])
                    .filter(([tid]) => /^\d{1,18}$/u.test(tid))
                    .sort((a, b) => Number(b[0]) - Number(a[0]));
                const showXhsText = cfg.settingsIconStyle === 'xhsText';
                const showGrid = cfg.settingsIconStyle === 'grid';
                const showShuiyuan = cfg.settingsIconStyle === 'shuiyuan';
                const showSvgIconColor = showGrid || showShuiyuan;
                const svgIconColorKey = showGrid ? 'settingsIconGridColor' : 'settingsIconGearColor';
                const svgIconColorDesc = showGrid ? '仅“书”样式生效' : '仅“设置齿轮”样式生效';
                const svgIconColorPresetDesc = showGrid ? '仅“书”样式生效' : '一键套用（仍可继续微调）';
                const keywordLexiconText = Utils.escapeHtml(cfg.keywordHighlightLexicon || '');
                const keywordLexiconCount = Config.normalizeKeywordHighlightLexicon(cfg.keywordHighlightLexicon).length;
                panel.innerHTML = `
                    <div class="xhs-panel-header">
                        <span>小水书 v${VERSION}</span>
                        <span class="xhs-panel-close">×</span>
                    </div>
                    <div class="xhs-panel-body">
                        <div class="xhs-section ${cfg.panelCollapsed?.layout ? 'xhs-collapsed' : ''}" data-section="layout">
                            <div class="xhs-section-title" data-section-title="layout">布局</div>
                            <div class="xhs-section-body">
                            <div class="xhs-row">
                                <div>
                                    <div>启用小水书模式</div>
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
                            ${cfg.cardStagger ? '' : `
                            <div class="xhs-row">
                                <div>
                                    <div>卡片长宽比</div>
                                    <div class="xhs-desc">仅在关闭“卡片错落布局”时生效（宽/高）</div>
                                </div>
                                <input class="xhs-input" type="number" min="0.6" max="3.0" step="0.05" value="${cfg.gridCardAspectRatio}" data-input="gridCardAspectRatio" />
                            </div>
                            `}
                            <div class="xhs-row">
                                <div>
                                    <div>列数</div>
                                    <div class="xhs-desc">桌面端基准列数（1–50；移动端会自动降到 1-3 列）</div>
                                </div>
                                <input class="xhs-input" type="number" min="1" max="50" step="1" value="${cfg.columnCount}" data-input="columnCount" />
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>元信息布局</div>
                                    <div class="xhs-desc">紧凑：作者+统计同一行；宽松：作者+更新时间一行，统计另起一行</div>
                                </div>
                                <select class="xhs-input" data-select="metaLayout">
                                    <option value="compact" ${cfg.metaLayout === 'compact' ? 'selected' : ''}>紧凑型</option>
                                    <option value="spacious" ${cfg.metaLayout === 'spacious' ? 'selected' : ''}>宽松型</option>
                                </select>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>贴主展示</div>
                                    <div class="xhs-desc">头像/用户名显示方式</div>
                                </div>
                                <select class="xhs-input" data-select="authorDisplay">
                                    <option value="full" ${cfg.authorDisplay === 'full' ? 'selected' : ''}>完整展示</option>
                                    <option value="avatar" ${cfg.authorDisplay === 'avatar' ? 'selected' : ''}>只展示头像</option>
                                    <option value="name" ${cfg.authorDisplay === 'name' ? 'selected' : ''}>只展示用户名</option>
                                </select>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>Pill 大小</div>
                                    <div class="xhs-desc">分类/标签 pill 的缩放（1.00=原始）</div>
                                </div>
                                <input class="xhs-input" type="number" min="0.5" max="5.0" step="0.05" value="${cfg.pillScale}" data-input="pillScale" />
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>Pill 不透明度</div>
                                    <div class="xhs-desc">封面左上角 pill 的背景不透明度倍率（越大越清晰；0.2–1.0）</div>
                                </div>
                                <input class="xhs-input" type="number" min="0.2" max="1.0" step="0.05" value="${cfg.pillOpacity}" data-input="pillOpacity" />
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>封面左上角 Pill</div>
                                    <div class="xhs-desc">分类/标签 pill（仅影响封面左上角展示）</div>
                                </div>
                                <div class="xhs-switch ${cfg.coverPillsEnabled?'on':''}" data-key="coverPillsEnabled"></div>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>文字封面风格</div>
                                    <div class="xhs-desc">统一封面构件：经典/笔记/毛玻璃/大字报拼贴 + 自定义混合</div>
                                </div>
                                <select class="xhs-input" data-select="textCoverStyle" style="width: 180px;">
                                    <option value="classic" ${cfg.textCoverStyle === 'classic' ? 'selected' : ''}>经典（当前）</option>
                                    <option value="notebook" ${cfg.textCoverStyle === 'notebook' ? 'selected' : ''}>方格笔记版</option>
                                    <option value="glass" ${cfg.textCoverStyle === 'glass' ? 'selected' : ''}>毛玻璃版</option>
                                    <option value="collage" ${cfg.textCoverStyle === 'collage' ? 'selected' : ''}>大字报拼贴风</option>
                                    <option value="mix_custom" ${cfg.textCoverStyle === 'mix_custom' ? 'selected' : ''}>自定义混合</option>
                                </select>
                            </div>
                            <div class="xhs-row">
                                <div style="width:100%;">
                                    <div>风格预览（点击即切换）</div>
                                    <div class="xhs-desc">混合模式会按帖子稳定随机分配，不会每次刷新乱跳</div>
                                    <div class="xhs-style-preview-grid">
                                        <button class="xhs-style-preview-item ${cfg.textCoverStyle === 'classic' ? 'active' : ''}" type="button" data-action="setTextCoverStyle" data-style="classic"><span class="xhs-style-preview-label">经典</span><span class="xhs-style-preview-sub">C</span></button>
                                        <button class="xhs-style-preview-item ${cfg.textCoverStyle === 'notebook' ? 'active' : ''}" type="button" data-action="setTextCoverStyle" data-style="notebook"><span class="xhs-style-preview-label">笔记</span><span class="xhs-style-preview-sub">N</span></button>
                                        <button class="xhs-style-preview-item ${cfg.textCoverStyle === 'glass' ? 'active' : ''}" type="button" data-action="setTextCoverStyle" data-style="glass"><span class="xhs-style-preview-label">毛玻璃</span><span class="xhs-style-preview-sub">G</span></button>
                                        <button class="xhs-style-preview-item ${cfg.textCoverStyle === 'collage' ? 'active' : ''}" type="button" data-action="setTextCoverStyle" data-style="collage"><span class="xhs-style-preview-label">拼贴</span><span class="xhs-style-preview-sub">C+</span></button>
                                        <button class="xhs-style-preview-item ${cfg.textCoverStyle === 'mix_custom' ? 'active' : ''}" type="button" data-action="setTextCoverStyle" data-style="mix_custom"><span class="xhs-style-preview-label">混合</span><span class="xhs-style-preview-sub">Mix</span></button>
                                    </div>
                                </div>
                            </div>
                            <div class="xhs-row">
                                <div style="width:100%;">
                                    <div>混合模式样式池</div>
                                    <div class="xhs-desc">仅“自定义混合”生效；可多选，且至少保留一种样式</div>
                                    <div class="xhs-text-cover-mix-pool ${cfg.textCoverStyle === 'mix_custom' ? '' : 'is-disabled'}">
                                        <button class="xhs-text-cover-mix-pill ${cfg.textCoverMixPool.includes('classic') ? 'active' : ''}" type="button" data-action="toggleTextCoverMixStyle" data-style="classic">经典</button>
                                        <button class="xhs-text-cover-mix-pill ${cfg.textCoverMixPool.includes('notebook') ? 'active' : ''}" type="button" data-action="toggleTextCoverMixStyle" data-style="notebook">笔记</button>
                                        <button class="xhs-text-cover-mix-pill ${cfg.textCoverMixPool.includes('glass') ? 'active' : ''}" type="button" data-action="toggleTextCoverMixStyle" data-style="glass">毛玻璃</button>
                                        <button class="xhs-text-cover-mix-pill ${cfg.textCoverMixPool.includes('collage') ? 'active' : ''}" type="button" data-action="toggleTextCoverMixStyle" data-style="collage">拼贴</button>
                                    </div>
                                </div>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>关键词突出显示</div>
                                    <div class="xhs-desc">按词库高亮封面摘要关键词</div>
                                </div>
                                <div class="xhs-switch ${cfg.keywordHighlightEnabled?'on':''}" data-key="keywordHighlightEnabled"></div>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>关键词样式</div>
                                    <div class="xhs-desc">支持下划线、背景高亮、波浪线等效果</div>
                                </div>
                                <select class="xhs-input" data-select="keywordHighlightStyle" style="width: 150px;">
                                    <option value="random" ${cfg.keywordHighlightStyle === 'random' ? 'selected' : ''}>随机混搭</option>
                                    <option value="hl" ${cfg.keywordHighlightStyle === 'hl' ? 'selected' : ''}>背景高亮</option>
                                    <option value="ul" ${cfg.keywordHighlightStyle === 'ul' ? 'selected' : ''}>下划线</option>
                                    <option value="wave" ${cfg.keywordHighlightStyle === 'wave' ? 'selected' : ''}>波浪线</option>
                                    <option value="dot" ${cfg.keywordHighlightStyle === 'dot' ? 'selected' : ''}>重点点标</option>
                                    <option value="bd" ${cfg.keywordHighlightStyle === 'bd' ? 'selected' : ''}>加粗强调</option>
                                </select>
                            </div>
                            <div class="xhs-row">
                                <div style="width:100%;">
                                    <div>关键词词库</div>
                                    <div class="xhs-desc">一行一个关键词，最多 200 个（当前 ${keywordLexiconCount} 个）</div>
                                    <textarea class="xhs-input xhs-textarea" data-input-text="keywordHighlightLexicon" placeholder="例如：&#10;奖学金&#10;保研&#10;租房">${keywordLexiconText}</textarea>
                                    <div class="xhs-inline-actions">
                                        <button class="xhs-btn xhs-mini-btn" type="button" data-action="saveKeywordLexicon">保存词库</button>
                                        <button class="xhs-btn xhs-mini-btn" type="button" data-action="restoreKeywordLexicon">恢复默认词库</button>
                                        <button class="xhs-btn xhs-mini-btn" type="button" data-action="clearKeywordLexicon">清空词库</button>
                                    </div>
                                </div>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>帖子页回复卡片化</div>
                                    <div class="xhs-desc">把每层回复包装成更“卡片”的层级（仅 /t/... 生效；私信页自动关闭）</div>
                                </div>
                                <div class="xhs-switch ${cfg.topicReplyCards?'on':''}" data-key="topicReplyCards"></div>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>帖子页向上加载不跳楼</div>
                                    <div class="xhs-desc">向上滚动触发“加载上方更多”时尽量保持当前楼层位置（默认开启）</div>
                                </div>
                                <div class="xhs-switch ${cfg.topicScrollKeepPosition?'on':''}" data-key="topicScrollKeepPosition"></div>
                            </div>
                            ${cfg.topicReplyCards ? `
                                <div class="xhs-row">
                                    <div>
                                        <div>回复卡片左侧缩进</div>
                                        <div class="xhs-desc">调整正文区域左侧留白（px）</div>
                                    </div>
                                    <input class="xhs-input" type="number" min="0" max="80" step="1" value="${cfg.topicReplyCardsBodyPaddingLeft}" data-input="topicReplyCardsBodyPaddingLeft" />
                                </div>
                            ` : ''}
                            </div>
                        </div>

                        <div class="xhs-section ${cfg.panelCollapsed?.stats ? 'xhs-collapsed' : ''}" data-section="stats">
                            <div class="xhs-section-title" data-section-title="stats">统计</div>
                            <div class="xhs-section-body">
                            <div class="xhs-row">
                                <div>
                                    <div>显示统计数据</div>
                                    <div class="xhs-desc">总开关（更细粒度项在下面）</div>
                                </div>
                                <div class="xhs-switch ${cfg.showStats?'on':''}" data-key="showStats"></div>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>统计对齐</div>
                                    <div class="xhs-desc">宽松型布局下：左端/右端/两端对齐</div>
                                </div>
                                <select class="xhs-input" data-select="statsAlign">
                                    <option value="left" ${cfg.statsAlign === 'left' ? 'selected' : ''}>左端对齐</option>
                                    <option value="right" ${cfg.statsAlign === 'right' ? 'selected' : ''}>右端对齐</option>
                                    <option value="justify" ${cfg.statsAlign === 'justify' ? 'selected' : ''}>两端对齐</option>
                                </select>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>封面贴纸</div>
                                    <div class="xhs-desc">置顶/精华/热议等；关注话题会优先显示未读</div>
                                </div>
                                <div class="xhs-switch ${cfg.stickerEnabled?'on':''}" data-key="stickerEnabled"></div>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>关注话题未读数</div>
                                    <div class="xhs-desc">跟踪/关注话题的封面贴纸优先显示“未读 n”</div>
                                </div>
                                <div class="xhs-switch ${cfg.showUnreadPosts?'on':''}" data-key="showUnreadPosts"></div>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>上次回复时间</div>
                                    <div class="xhs-desc">仅“宽松型”元信息布局会显示</div>
                                </div>
                                <div class="xhs-switch ${cfg.showStatLastActivity?'on':''}" data-key="showStatLastActivity"></div>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>❤️ 点赞数</div>
                                </div>
                                <div class="xhs-switch ${cfg.showStatLikes?'on':''}" data-key="showStatLikes"></div>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>💬 回复数</div>
                                </div>
                                <div class="xhs-switch ${cfg.showStatReplies?'on':''}" data-key="showStatReplies"></div>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>👁️ 观看数</div>
                                </div>
                                <div class="xhs-switch ${cfg.showStatViews?'on':''}" data-key="showStatViews"></div>
                            </div>
                            </div>
                        </div>

                        <div class="xhs-section ${cfg.panelCollapsed?.cache ? 'xhs-collapsed' : ''}" data-section="cache">
                            <div class="xhs-section-title" data-section-title="cache">缓存</div>
                            <div class="xhs-section-body">
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
                                    <div class="xhs-desc">过期后会重新请求（默认 20160=14 days）</div>
                                </div>
                                <input class="xhs-input" type="number" min="1" max="129600" step="1" value="${cfg.cacheTtlMinutes}" data-input="cacheTtlMinutes" />
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
                                    <div>清理缓存</div>
                                    <div class="xhs-desc">清空封面/点赞跨页面缓存（用于修复封面不刷新）</div>
                                </div>
                                <button class="xhs-btn danger" type="button" data-action="clearCache">清理</button>
                            </div>
                            </div>
                        </div>

                        <div class="xhs-section ${cfg.panelCollapsed?.images ? 'xhs-collapsed' : ''}" data-section="images">
                            <div class="xhs-section-title" data-section-title="images">图片</div>
                            <div class="xhs-section-body">
                            <div class="xhs-row">
                                <div>
                                    <div>过加载模式</div>
                                    <div class="xhs-desc">扩大预取范围，让封面/点赞更早加载（可能增加请求）</div>
                                </div>
                                <div class="xhs-switch ${cfg.overfetchMode?'on':''}" data-key="overfetchMode"></div>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>智能裁剪封面</div>
                                    <div class="xhs-desc">仅极端宽/长图会裁剪，减少卡片“超长图”影响</div>
                                </div>
                                <div class="xhs-switch ${cfg.imgCropEnabled?'on':''}" data-key="imgCropEnabled"></div>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>裁剪基准比例</div>
                                    <div class="xhs-desc">宽/高。图片过宽或过长时会裁到边界比例（默认 1.618）</div>
                                </div>
                                <input class="xhs-input" type="number" min="0.6" max="3.0" step="0.05" value="${cfg.imgCropBaseRatio}" data-input="imgCropBaseRatio" />
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>新帖提示避让</div>
                                    <div class="xhs-desc">用于“查看 x 个新的或更新的话题”与卡片的间距处理</div>
                                </div>
                                <select class="xhs-input" data-select="listNoticeSpacingMode" style="width: 136px;">
                                    <option value="smart" ${cfg.listNoticeSpacingMode === 'smart' ? 'selected' : ''}>智能（推荐）</option>
                                    <option value="legacy" ${cfg.listNoticeSpacingMode === 'legacy' ? 'selected' : ''}>经典（旧版）</option>
                                    <option value="off" ${cfg.listNoticeSpacingMode === 'off' ? 'selected' : ''}>关闭避让</option>
                                </select>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>按帖隐藏主楼图</div>
                                    <div class="xhs-desc">可在卡片封面左下角悬浮按钮切换“主楼图/仅文字封面”；当前 ${hiddenCoverEntries.length} 条</div>
                                </div>
                                <button class="xhs-btn danger" type="button" data-action="clearHiddenCovers" ${hiddenCoverEntries.length ? '' : 'disabled'}>清空</button>
                            </div>
                            ${hiddenCoverEntries.length ? `
                                <div class="xhs-hidden-cover-list">
                                    ${hiddenCoverEntries.map(([tid, t]) => `
                                        <div class="xhs-hidden-cover-item" data-hidden-tid="${Utils.escapeHtml(tid)}">
                                            <a class="xhs-hidden-cover-title" href="/t/topic/${Utils.escapeHtml(tid)}" data-action="openHiddenCoverTopic" data-tid="${Utils.escapeHtml(tid)}" title="打开话题：${Utils.escapeHtml(t || `话题 ${tid}`)}">${Utils.escapeHtml(t || `话题 ${tid}`)}</a>
                                            <span class="xhs-hidden-cover-tid">#${Utils.escapeHtml(tid)}</span>
                                            <button class="xhs-btn xhs-mini-btn" type="button" data-action="restoreHiddenCover" data-tid="${Utils.escapeHtml(tid)}">恢复</button>
                                        </div>
                                    `).join('')}
                                </div>
                            ` : `<div class="xhs-desc">暂无“仅文字封面”的帖子</div>`}
                            </div>
                        </div>

                        <div class="xhs-section ${cfg.panelCollapsed?.advanced ? 'xhs-collapsed' : ''}" data-section="advanced">
                            <div class="xhs-section-title" data-section-title="advanced">高级</div>
                            <div class="xhs-section-body">
                            <div class="xhs-row">
                                <div>
                                    <div>请求速率限制</div>
                                    <div class="xhs-desc">降低 429 风险；当前间隔 ${(Grid.rateLimit?.interval || cfg.rateMinIntervalMs)}ms（基础 ${cfg.rateMinIntervalMs}ms）</div>
                                </div>
                                <div class="xhs-switch ${cfg.rateLimitEnabled?'on':''}" data-key="rateLimitEnabled"></div>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>最小请求间隔</div>
                                    <div class="xhs-desc">单位毫秒（越小越激进）</div>
                                </div>
                                <input class="xhs-input" type="number" min="120" max="5000" step="10" value="${cfg.rateMinIntervalMs}" data-input="rateMinIntervalMs" />
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>429 冷却秒数</div>
                                    <div class="xhs-desc">遇到 429 至少等待这么久（与 Retry-After 取较大值）</div>
                                </div>
                                <input class="xhs-input" type="number" min="1" max="60" step="1" value="${cfg.rateCooldownSeconds}" data-input="rateCooldownSeconds" />
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>自动调速</div>
                                    <div class="xhs-desc">遇到 429 自动放慢，成功后缓慢恢复</div>
                                </div>
                                <div class="xhs-switch ${cfg.rateAutoTune?'on':''}" data-key="rateAutoTune"></div>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>调试模式</div>
                                    <div class="xhs-desc">打开后会暴露 window.__xhsDebug（用于排查回退/缓存/渲染问题）</div>
                                </div>
                                <div class="xhs-switch ${cfg.debugMode?'on':''}" data-key="debugMode"></div>
                            </div>
                            </div>
                        </div>

                        <div class="xhs-section ${cfg.panelCollapsed?.theme ? 'xhs-collapsed' : ''}" data-section="theme">
                            <div class="xhs-section-title" data-section-title="theme">主题</div>
                            <div class="xhs-section-body">
                            <div class="xhs-row">
                                <div>
                                    <div>深色模式</div>
                                    <div class="xhs-desc">自动：跟随水源主题；也可强制深色/浅色</div>
                                </div>
                                <select class="xhs-input" data-select="darkMode">
                                    <option value="auto" ${cfg.darkMode === 'auto' ? 'selected' : ''}>自动</option>
                                    <option value="dark" ${cfg.darkMode === 'dark' ? 'selected' : ''}>强制深色</option>
                                    <option value="light" ${cfg.darkMode === 'light' ? 'selected' : ''}>强制浅色</option>
                                </select>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>设置按钮图标样式</div>
                                    <div class="xhs-desc">设置齿轮 / 书 / “小水书”渐变字</div>
                                </div>
                                <select class="xhs-input" data-select="settingsIconStyle">
                                    <option value="shuiyuan" ${cfg.settingsIconStyle === 'shuiyuan' ? 'selected' : ''}>设置齿轮</option>
                                    <option value="grid" ${cfg.settingsIconStyle === 'grid' ? 'selected' : ''}>书</option>
                                    <option value="xhsText" ${cfg.settingsIconStyle === 'xhsText' ? 'selected' : ''}>小水书渐变字</option>
                                </select>
                            </div>
                            <div class="xhs-row">
                                <div>
                                    <div>图标大小</div>
                                    <div class="xhs-desc">影响顶部/悬浮按钮的图标尺寸（px）</div>
                                </div>
                                <input class="xhs-input" type="number" min="14" max="36" step="1" value="${cfg.settingsIconSize}" data-input="settingsIconSize" />
                            </div>
                            ${showSvgIconColor ? `
                                <div class="xhs-row">
                                    <div>
                                        <div>SVG 配色</div>
                                        <div class="xhs-desc">${svgIconColorDesc}</div>
                                    </div>
                                    <input class="xhs-input" type="color" value="${cfg[svgIconColorKey]}" data-input="${svgIconColorKey}" />
                                </div>
                                <div class="xhs-row">
                                    <div>
                                        <div>SVG 配色预设</div>
                                        <div class="xhs-desc">${svgIconColorPresetDesc}</div>
                                    </div>
                                    <div style="flex: 0 0 auto; width: 88px;"></div>
                                </div>
                                <div class="xhs-gradients">
                                    ${[
                                        { name: '灰', color: '#B5B5B5' },
                                        { name: '深灰', color: '#595959' },
                                        { name: '交大红', color: '#C8102E' },
                                        { name: '水源蓝', color: '#0085CA' },
                                        { name: '清新绿', color: '#52c41a' },
                                        { name: '神秘紫', color: '#722ed1' },
                                    ].map((g) => `
                                        <div class="xhs-gradient-item ${(cfg[svgIconColorKey]===g.color) ? 'active' : ''}"
                                             style="--gt:${g.color}; --gb:${g.color};"
                                             title="${g.name}"
                                             data-svg-color-key="${svgIconColorKey}"
                                             data-svg-color="${g.color}"></div>
                                    `).join('')}
                                </div>
                            ` : ''}
                            ${showXhsText ? `
                                <div class="xhs-row">
                                    <div>
                                        <div>渐变字大小</div>
                                        <div class="xhs-desc">调大可减少留白</div>
                                    </div>
                                    <input class="xhs-input" type="number" min="0.50" max="5" step="0.05" value="${cfg.settingsIconTextScale}" data-input="settingsIconTextScale" />
                                </div>
                                <div class="xhs-row">
                                    <div>
                                        <div>“小水书”文案</div>
                                        <div class="xhs-desc">建议不超过 6 个字</div>
                                    </div>
                                    <input class="xhs-input" type="text" value="${Utils.escapeHtml(cfg.settingsIconXhsText || '小水书')}" data-input="settingsIconXhsText" />
                                </div>
                                <div class="xhs-row">
                                    <div>
                                        <div>Logo 渐变色</div>
                                        <div class="xhs-desc">仅影响“渐变字”图标</div>
                                    </div>
                                    <div style="display:flex; gap:8px; align-items:center;">
                                        <input class="xhs-input" type="color" value="${cfg.settingsIconGradientTop}" data-input="settingsIconGradientTop" />
                                        <input class="xhs-input" type="color" value="${cfg.settingsIconGradientBottom}" data-input="settingsIconGradientBottom" />
                                    </div>
                                </div>
                                <div class="xhs-row">
                                    <div>
                                        <div>Logo 渐变预设</div>
                                        <div class="xhs-desc">一键套用（仍可继续微调）</div>
                                    </div>
                                    <div style="flex: 0 0 auto; width: 88px;"></div>
                                </div>
                                <div class="xhs-gradients">
                                    ${[
                                        { name: '水源蓝', top: '#33CCFF', bottom: '#0066CC' },
                                        { name: '交大红', top: '#ff4d4f', bottom: '#C8102E' },
                                        { name: '紫粉', top: '#9254de', bottom: '#eb2f96' },
                                        { name: '青绿', top: '#36cfc9', bottom: '#52c41a' },
                                        { name: '日落', top: '#fa541c', bottom: '#faad14' },
                                        { name: '银灰', top: '#d9d9d9', bottom: '#8c8c8c' },
                                    ].map((g) => `
                                        <div class="xhs-gradient-item ${(cfg.settingsIconGradientTop===g.top && cfg.settingsIconGradientBottom===g.bottom) ? 'active' : ''}"
                                             style="--gt:${g.top}; --gb:${g.bottom};"
                                             title="${g.name}"
                                             data-grad-top="${g.top}"
                                             data-grad-bottom="${g.bottom}"></div>
                                    `).join('')}
                                </div>
                            ` : ''}
                            <div class="xhs-row">
                                <div>
                                    <div>主题色预设</div>
                                    <div class="xhs-desc">影响卡片/高亮/边框等（不是 Logo 渐变）</div>
                                </div>
                                <div style="flex: 0 0 auto; width: 88px;"></div>
                            </div>
                            <div class="xhs-colors">
                                ${Object.entries(Config.themes).map(([k,v]) => `
                                    <div class="xhs-color-item ${cfg.themeColor===v?'active':''}" 
                                         style="background:${v}" 
                                         title="${k}"
                                         data-color="${v}"></div>
                                `).join('')}
                            </div>
                            <div class="xhs-section-actions">
                                <span class="xhs-reset" style="cursor:pointer;text-decoration:underline; color:#999; font-size:12px;">重置设置</span>
                            </div>
                            </div>
                        </div>
                    </div>
                `;
                try {
                    const body = panel.querySelector('.xhs-panel-body');
                    if (body) body.scrollTop = prevScrollTop;
                } catch {}
                
                // 绑定关闭事件
                panel.querySelector('.xhs-panel-close').onclick = (e) => {
                    e.preventDefault?.();
                    App.closeSettingsPanel();
                };

                // 绑定配置项点击（避免依赖 inline onclick，兼容更严格 CSP）
                const toggleKey = (k) => {
                    const c = Config.get();
                    Config.set(k, !c[k]);
                    render();
                    App.applyConfig();
                };
                panel.querySelectorAll('.xhs-section-title[data-section-title]').forEach((title) => {
                    title.addEventListener('click', () => {
                        const id = title.getAttribute('data-section-title');
                        if (!id) return;
                        const cfg2 = Config.get();
                        const cur = Boolean(cfg2.panelCollapsed?.[id]);
                        Config.setCollapsedSection(id, !cur);
                        render();
                    });
                });
                panel.querySelectorAll('.xhs-switch[data-key]').forEach((sw) => {
                    sw.onclick = () => toggleKey(sw.getAttribute('data-key'));
                });
                panel.querySelectorAll('input.xhs-input[data-input]').forEach((input) => {
                    input.onchange = () => {
                        const k = input.getAttribute('data-input');
                        const raw = input.value;
                        const isFloat = (k === 'imgCropBaseRatio' || k === 'gridCardAspectRatio' || k === 'pillScale' || k === 'pillOpacity' || k === 'settingsIconTextScale');
                        const isText = (k === 'settingsIconXhsText');
                        const isColor = (k === 'settingsIconGradientTop' || k === 'settingsIconGradientBottom' || k === 'settingsIconGridColor' || k === 'settingsIconGearColor');
                        const v = isText || isColor ? String(raw || '').trim() : (isFloat ? parseFloat(raw) : parseInt(raw, 10));
                        Config.set(k, v);
                        render();
                        App.applyConfig();
                    };
                });
                panel.querySelectorAll('textarea.xhs-input[data-input-text]').forEach((textarea) => {
                    textarea.onchange = () => {
                        const k = textarea.getAttribute('data-input-text');
                        if (!k) return;
                        Config.set(k, String(textarea.value || ''));
                        render();
                        App.applyConfig();
                    };
                });
                panel.querySelectorAll('select.xhs-input[data-select]').forEach((sel) => {
                    sel.onchange = () => {
                        const k = sel.getAttribute('data-select');
                        const v = sel.value;
                        Config.set(k, v);
                        render();
                        App.applyConfig();
                    };
                });
                panel.querySelectorAll('[data-action="setTextCoverStyle"][data-style]').forEach((btn) => {
                    btn.addEventListener('click', () => {
                        const style = String(btn.getAttribute('data-style') || '').trim();
                        const allowed = new Set(['classic', 'notebook', 'glass', 'collage', 'mix_custom']);
                        if (!allowed.has(style)) return;
                        Config.set('textCoverStyle', style);
                        render();
                        App.applyConfig();
                    });
                });
                panel.querySelector('[data-action="saveKeywordLexicon"]')?.addEventListener('click', () => {
                    const textarea = panel.querySelector('textarea.xhs-input[data-input-text="keywordHighlightLexicon"]');
                    if (!textarea) return;
                    Config.set('keywordHighlightLexicon', String(textarea.value || ''));
                    render();
                    App.applyConfig();
                });
                panel.querySelector('[data-action="restoreKeywordLexicon"]')?.addEventListener('click', () => {
                    Config.set('keywordHighlightLexicon', Config.defaults.keywordHighlightLexicon || '');
                    render();
                    App.applyConfig();
                });
                panel.querySelector('[data-action="clearKeywordLexicon"]')?.addEventListener('click', () => {
                    if (!confirm('确定清空关键词词库吗？清空后将不再对摘要文本做关键词强调。')) return;
                    Config.set('keywordHighlightLexicon', '');
                    render();
                    App.applyConfig();
                });
                panel.querySelectorAll('[data-action="toggleTextCoverMixStyle"][data-style]').forEach((btn) => {
                    btn.addEventListener('click', () => {
                        const style = String(btn.getAttribute('data-style') || '').trim();
                        const allowed = ['classic', 'notebook', 'glass', 'collage'];
                        if (!allowed.includes(style)) return;
                        const cfg2 = Config.get();
                        const current = Config.normalizeTextCoverMixPool(cfg2.textCoverMixPool);
                        const set = new Set(current);
                        if (set.has(style)) {
                            if (set.size <= 1) return;
                            set.delete(style);
                        } else {
                            set.add(style);
                        }
                        const next = allowed.filter((name) => set.has(name));
                        Config.set('textCoverMixPool', next);
                        render();
                        App.applyConfig();
                    });
                });
                panel.querySelectorAll('.xhs-color-item[data-color]').forEach((item) => {
                    item.onclick = () => {
                        const c = item.getAttribute('data-color');
                        Config.set('themeColor', c);
                        render();
                        Styles.injectTheme();
                    };
                });
                panel.querySelectorAll('.xhs-gradient-item[data-grad-top][data-grad-bottom]').forEach((item) => {
                    item.onclick = () => {
                        const top = item.getAttribute('data-grad-top') || '';
                        const bottom = item.getAttribute('data-grad-bottom') || '';
                        if (!top || !bottom) return;
                        Config.set('settingsIconGradientTop', top);
                        Config.set('settingsIconGradientBottom', bottom);
                        render();
                        App.applyConfig();
                    };
                });
                panel.querySelectorAll('.xhs-gradient-item[data-svg-color-key][data-svg-color]').forEach((item) => {
                    item.onclick = () => {
                        const k = item.getAttribute('data-svg-color-key') || '';
                        const c = item.getAttribute('data-svg-color') || '';
                        if (!k || !c) return;
                        Config.set(k, c);
                        render();
                        App.applyConfig();
                    };
                });
                panel.querySelector('[data-action="clearCache"]')?.addEventListener('click', () => {
                    if (!confirm('清空跨页面缓存（封面/点赞）并刷新页面？')) return;
                    try { GM_setValue('xhs_topic_cache_v1', '{}'); } catch {}   
                    try { Grid.persistentCache = null; } catch {}
                    try { Grid.cache?.clear?.(); } catch {}
                    try { Grid.coverRevalidatedInSession?.clear?.(); } catch {}
                    try { location.reload(); } catch {}
                });
                panel.querySelectorAll('[data-action="restoreHiddenCover"][data-tid]').forEach((btn) => {
                    btn.addEventListener('click', () => {
                        const tid = String(btn.getAttribute('data-tid') || '').trim();
                        if (!tid) return;
                        Config.unsetCoverHidden(tid);
                        Grid.applyCoverPreferenceToAllCards(tid);
                        document.querySelectorAll(`.xhs-card[data-tid="${CSS.escape(tid)}"]`).forEach((card) => {
                            const cached = Grid.cache.get(tid);
                            const cover = card.querySelector('.xhs-cover');
                            const hasImg = Boolean(cover?.querySelector?.('img.xhs-real-img'));
                            if (!hasImg && (!cached || cached.needsImage)) Grid.queue.push({ el: card, tid });
                        });
                        Grid.processQueue();
                        render();
                        App.applyConfig();
                    });
                });
                panel.querySelector('[data-action="clearHiddenCovers"]')?.addEventListener('click', () => {
                    const count = Object.keys(Config.get().hiddenCoverTopics || {}).length;
                    if (!count) return;
                    if (!confirm(`清空 ${count} 条“仅文字封面”设置？`)) return;
                    Config.clearCoverHidden();
                    document.querySelectorAll('.xhs-card[data-tid]').forEach((card) => {
                        const tid = String(card.getAttribute('data-tid') || '');
                        Grid.applyCoverPreferenceToCard(card);
                        const cached = Grid.cache.get(tid);
                        const cover = card.querySelector('.xhs-cover');
                        const hasImg = Boolean(cover?.querySelector?.('img.xhs-real-img'));
                        if (tid && (!cached || cached.needsImage)) {
                            Grid.queue.push({ el: card, tid });
                        } else if (!hasImg) {
                            Grid.applyCoverPreferenceToCard(card);
                        }
                    });
                    Grid.processQueue();
                    render();
                    App.applyConfig();
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
                    App.closeSettingsPanel();
                }
            };
            // 防止“背景页面滚动”：在打开设置时锁定页面滚动，并在 overlay 上阻止滚动穿透
            overlay.addEventListener('wheel', (e) => {
                try {
                    if (!overlay.classList.contains('show')) return;
                    const body = panel.querySelector('.xhs-panel-body');
                    if (body && body.contains(e.target)) return;
                    e.preventDefault();
                } catch {}
            }, { passive: false });
            overlay.addEventListener('touchmove', (e) => {
                try {
                    if (!overlay.classList.contains('show')) return;
                    const body = panel.querySelector('.xhs-panel-body');
                    if (body && body.contains(e.target)) return;
                    e.preventDefault();
                } catch {}
            }, { passive: false });
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
