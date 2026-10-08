// Tells the parent page (the Squarespace iframe embed) how tall this app
// would like to be, so the iframe can resize itself and Squarespace never
// ends up with two scrollbars. Pairs with squarespace-embed.html, which
// listens for this message and applies it to the iframe's height.
//
// This is a full-bleed map app, not flowing content, so there's no single
// "natural" content height to measure. Instead this clamps to a comfortable
// slice of the viewport: tall enough to be useful, short enough that it
// doesn't take over a tall desktop screen or get squeezed to nothing on a
// short mobile one. Harmless no-op when the page isn't embedded in an iframe.
(function () {
  if (window.top === window.self) return; // not embedded, nothing to do

  function postHeight() {
    const height = Math.max(520, Math.min(window.innerHeight, 900));
    window.parent.postMessage({ type: 'canal-map-resize', height }, '*');
  }

  postHeight();
  window.addEventListener('resize', postHeight);
  window.addEventListener('orientationchange', postHeight);
})();
