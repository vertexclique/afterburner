/* ============================================================
   AFTERBURNER — Shared Tweaks System
   Used by both index.html (landing) and docs.html.
   Reads `window.TWEAK_DEFAULTS` declared inline in each page so
   the host can rewrite the EDITMODE-BEGIN/END block on disk.
   ============================================================ */
(function () {
  'use strict';

  // Mood presets — each reshapes the gradient, accent, and aurora colors together.
  const MOODS = {
    violet: {
      sunburst: 'linear-gradient(90deg, rgb(114, 50, 241) 3.13%, rgb(251, 118, 250) 50%, rgb(255, 207, 94))',
      dreamy:   'radial-gradient(circle, rgb(127, 125, 252), rgb(244, 75, 204) 33%, rgb(229, 237, 245) 66%)',
      action:   '#533afd',
      accent:   '#7f7dfc',
      auroraA:  'rgba(127, 125, 252, 0.55)',
      auroraB:  'rgba(244, 75, 204, 0.40)',
      auroraC:  'rgba(255, 168, 96, 0.40)',
    },
    inferno: {
      sunburst: 'linear-gradient(90deg, rgb(255, 46, 84) 0%, rgb(255, 122, 0) 50%, rgb(255, 207, 94))',
      dreamy:   'radial-gradient(circle, rgb(255, 122, 0), rgb(255, 46, 84) 33%, rgb(255, 233, 215) 66%)',
      action:   '#e8350a',
      accent:   '#ff6118',
      auroraA:  'rgba(255, 122, 0, 0.55)',
      auroraB:  'rgba(255, 46, 84, 0.45)',
      auroraC:  'rgba(255, 207, 94, 0.50)',
    },
    cyber: {
      sunburst: 'linear-gradient(90deg, rgb(0, 229, 255) 0%, rgb(124, 77, 255) 50%, rgb(255, 0, 168))',
      dreamy:   'radial-gradient(circle, rgb(124, 77, 255), rgb(0, 229, 255) 33%, rgb(225, 235, 255) 66%)',
      action:   '#7c4dff',
      accent:   '#00e5ff',
      auroraA:  'rgba(0, 229, 255, 0.55)',
      auroraB:  'rgba(124, 77, 255, 0.45)',
      auroraC:  'rgba(255, 0, 168, 0.40)',
    },
  };

  const DENSITY_SCALE = { airy: 1.4, standard: 1, compressed: 0.7 };

  // codeTheme controls the syntax-highlighting palette + ember animation.
  // 'auto' resolves to midnight across all moods — it's the cleanest read.
  const CODE_THEME_FOR_MOOD = { violet: 'midnight', inferno: 'midnight', cyber: 'midnight' };
  const VALID_CODE_THEMES = new Set(['midnight', 'inferno', 'matrix']);

  function resolveCodeTheme(s) {
    if (s.codeTheme && s.codeTheme !== 'auto' && VALID_CODE_THEMES.has(s.codeTheme)) return s.codeTheme;
    return CODE_THEME_FOR_MOOD[s.mood] || 'midnight';
  }

  const DEFAULTS = window.TWEAK_DEFAULTS || { mood: 'inferno', density: 'standard', intensity: 100, codeTheme: 'auto' };
  let state = { ...DEFAULTS };

  function applyTweaks(s) {
    const root = document.documentElement;

    // mood
    const m = MOODS[s.mood] || MOODS.violet;
    root.style.setProperty('--gradient-sunburst', m.sunburst);
    root.style.setProperty('--gradient-dreamy', m.dreamy);
    root.style.setProperty('--action', m.action);
    root.style.setProperty('--accent', m.accent);
    root.style.setProperty('--aurora-a', m.auroraA);
    root.style.setProperty('--aurora-b', m.auroraB);
    root.style.setProperty('--aurora-c', m.auroraC);

    // density
    root.style.setProperty('--density', DENSITY_SCALE[s.density] || 1);

    // intensity 0..100
    const k = Math.max(0, Math.min(100, +s.intensity || 0)) / 100;
    root.style.setProperty('--orb-glow', (0.6 + k * 0.6).toFixed(2));
    root.style.setProperty('--orb-glow-blur', (28 + k * 36).toFixed(0) + 'px');
    root.style.setProperty('--orb-pulse-dur', (4.6 - k * 1.6).toFixed(2) + 's');
    root.style.setProperty('--orb-spark-op', k.toFixed(2));

    // code theme — sets data-code-theme on <html>
    root.setAttribute('data-code-theme', resolveCodeTheme(s));

    // chip count: hide some chips at low intensity (only matters on landing page)
    const allChips = document.querySelectorAll('.orbital__chip');
    if (allChips.length) {
      const want = Math.max(2, Math.round(2 + k * (allChips.length - 2)));
      allChips.forEach((c, i) => {
        const keepCore = c.classList.contains('logo-chip');
        c.style.display = (keepCore || i < want) ? '' : 'none';
      });
      if (window.__orbitalRelayout) window.__orbitalRelayout();
    }
  }

  // Listen for host activation FIRST, then announce availability.
  window.addEventListener('message', (e) => {
    const d = e.data || {};
    const panel = document.getElementById('tweaks');
    if (!panel) return;
    if (d.type === '__activate_edit_mode') {
      panel.classList.add('open');
    } else if (d.type === '__deactivate_edit_mode') {
      panel.classList.remove('open');
    }
  });
  try { window.parent.postMessage({ type: '__edit_mode_available' }, '*'); } catch (e) {}

  function setTweak(key, val) {
    state = { ...state, [key]: val };
    applyTweaks(state);
    try {
      window.parent.postMessage({ type: '__edit_mode_set_keys', edits: { [key]: val } }, '*');
    } catch (e) {}
    document.querySelectorAll('[data-tw-key="' + key + '"]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.twVal === String(val));
    });
    if (key === 'intensity') {
      const slider = document.getElementById('tw-intensity');
      const sliderVal = document.getElementById('tw-intensity-val');
      if (slider) {
        slider.value = val;
        slider.style.setProperty('--p', val);
      }
      if (sliderVal) sliderVal.textContent = val;
    }
  }
  window.setTweak = setTweak;

  // Initial paint (CSS variables applied even before panel is wired).
  applyTweaks(state);

  function wirePanel() {
    const panel = document.getElementById('tweaks');
    if (!panel) return;

    const closeBtn = document.getElementById('tw-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        panel.classList.remove('open');
        try { window.parent.postMessage({ type: '__edit_mode_dismissed' }, '*'); } catch (e) {}
      });
    }

    document.querySelectorAll('[data-tw-key]').forEach(btn => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.twKey;
        let v = btn.dataset.twVal;
        if (k === 'intensity') v = +v;
        setTweak(k, v);
      });
    });

    const slider = document.getElementById('tw-intensity');
    const sliderVal = document.getElementById('tw-intensity-val');
    if (slider) {
      slider.value = state.intensity;
      slider.style.setProperty('--p', state.intensity);
      slider.addEventListener('input', e => {
        e.target.style.setProperty('--p', e.target.value);
        setTweak('intensity', +e.target.value);
      });
    }
    if (sliderVal) sliderVal.textContent = state.intensity;

    // mark initial active states
    Object.entries(state).forEach(([k, v]) => {
      document.querySelectorAll('[data-tw-key="' + k + '"]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.twVal === String(v));
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wirePanel);
  } else {
    wirePanel();
  }
})();
