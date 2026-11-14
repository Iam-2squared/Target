'use strict';
(() => {
  let layer;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  function hide() {
    if (!layer) return;
    layer.hidden = true;
    // Removing the falling elements cancels their finite CSS animations too.
    // There are no callbacks or timers that can restore an earlier jackpot.
    layer.replaceChildren();
  }

  function show({restored = false} = {}) {
    hide();
    if (restored || document.hidden || reducedMotion?.matches) return false;
    const stage = document.querySelector('.choice-stage');
    if (!stage) return false;
    if (!layer?.isConnected || layer.parentElement !== stage) {
      layer = document.createElement('div');
      layer.id = 'jackpotBillRain';
      layer.className = 'target-jackpot-rain';
      layer.setAttribute('aria-hidden', 'true');
      stage.insertBefore(layer, document.getElementById('rewardCelebration'));
    }

    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 20; index++) {
      const bundle = document.createElement('span');
      bundle.className = 'target-jackpot-bundle';
      bundle.textContent = '轟';
      // Stagger four waves over five lanes. Fixed cosmetic values keep the
      // animation independent from the server's reward draw and its retries.
      const wave = Math.floor(index / 5);
      const lane = (index * 3) % 5;
      bundle.style.setProperty('--bill-x', String(8 + lane * 21 + (wave % 2 ? 3 : -3)));
      bundle.style.setProperty('--bill-delay', (wave * 52 + lane * 9) + 'ms');
      bundle.style.setProperty('--bill-size', (82 + (index % 4) * 10) + 'px');
      bundle.style.setProperty('--bill-start-turn', ((index % 2 ? 1 : -1) * (8 + index % 5 * 5)) + 'deg');
      bundle.style.setProperty('--bill-end-turn', ((index % 2 ? -1 : 1) * (32 + index % 5 * 8)) + 'deg');
      bundle.style.setProperty('--bill-drift', ((index % 2 ? 1 : -1) * (12 + index % 4 * 9)) + 'px');
      fragment.append(bundle);
    }
    layer.replaceChildren(fragment);
    layer.hidden = false;
    return true;
  }

  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
  reducedMotion?.addEventListener?.('change', event => { if (event.matches) hide(); });
  window.TargetJackpotEffects = Object.freeze({show, hide});
})();
