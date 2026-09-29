// Delad toppmeny. <script src="/nav.js" data-menu="admin"> ger adminmenyn, annars publik meny.
(() => {
  const isAdmin = document.currentScript.dataset.menu === 'admin';
  const publicLinks = [['/', 'Live'], ['/results', 'Resultat'], ['/map', 'Karta']];
  const adminLinks = [['/admin', 'Admin'], ['/admin-scans', 'Skanningar'], ['/print', 'Skriv ut QR'], ['/scanner', 'Skanner']];
  const link = ([href, label]) =>
    `<a href="${href}"${location.pathname.replace(/\.html$/, '') === href ? ' aria-current="page"' : ''}>${label}</a>`;
  const links = isAdmin
    ? adminLinks.map(link).join('') + '<span class="sep"></span>' + publicLinks.map(link).join('')
    : publicLinks.map(link).join('');

  const header = document.createElement('header');
  header.className = isAdmin ? 'topbar' : 'topbar public';
  header.innerHTML = `<div class="topbar-inner">
    <a class="brand" href="${isAdmin ? '/admin' : '/'}">Lopp</a>
    <button class="menu-toggle" aria-label="Meny" aria-expanded="false">☰</button>
    <nav class="menu">${links}</nav>
  </div>`;
  document.body.prepend(header);

  const toggle = header.querySelector('.menu-toggle');
  toggle.onclick = () => toggle.setAttribute('aria-expanded', header.querySelector('.menu').classList.toggle('open'));

  fetch('/api/race-settings').then(r => r.json()).then(s => {
    const brand = header.querySelector('.brand');
    if (s?.namn) brand.textContent = s.namn;
    if (s?.has_logo) brand.insertAdjacentHTML('afterbegin', '<img class="logo" src="/api/logo" alt="">');
  }).catch(() => {});
})();
