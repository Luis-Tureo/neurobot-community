const stylesheetHref = '/panel-refinement.css';

if (!document.querySelector(`link[href="${stylesheetHref}"]`)) {
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = stylesheetHref;
  document.head.append(stylesheet);
}

void import('./minimal-community-panel-base.js').then(() => import('./panel-refinement.js'));
