// ─── Scroll reveal ─────────────────────────────────────────────────────────
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry, i) => {
    if (entry.isIntersecting) {
      // Stagger children of the same parent
      const siblings = Array.from(entry.target.parentElement.querySelectorAll('.scroll-reveal'));
      const idx = siblings.indexOf(entry.target);
      entry.target.style.transitionDelay = `${idx * 80}ms`;
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });

document.querySelectorAll('.scroll-reveal').forEach(el => revealObserver.observe(el));

// ─── Navbar background on scroll ───────────────────────────────────────────
const navbar = document.querySelector('.db-navbar');
window.addEventListener('scroll', () => {
  navbar.style.background = window.scrollY > 40
    ? 'rgba(8, 8, 15, 0.97)'
    : 'rgba(8, 8, 15, 0.85)';
}, { passive: true });

// ─── Smooth scroll for nav links ───────────────────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', e => {
    const id = link.getAttribute('href');
    if (id === '#') return;
    const target = document.querySelector(id);
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Close mobile nav if open
    const collapse = document.getElementById('navMain');
    if (collapse?.classList.contains('show')) {
      bootstrap.Collapse.getInstance(collapse)?.hide();
    }
  });
});

// ─── Preview panel switcher ────────────────────────────────────────────────
document.querySelectorAll('.pf-item').forEach(item => {
  item.addEventListener('click', () => {
    const panel = item.dataset.panel;

    // Update active list item
    document.querySelectorAll('.pf-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');

    // Swap preview state
    document.querySelectorAll('#ps-body .ps-state').forEach(s => {
      s.classList.toggle('active', s.dataset.state === panel);
    });
  });
});

// ─── Active nav link on scroll ─────────────────────────────────────────────
const sections   = document.querySelectorAll('section[id]');
const navLinks   = document.querySelectorAll('.db-navbar .nav-link');

const sectionObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      navLinks.forEach(link => {
        link.classList.toggle(
          'active',
          link.getAttribute('href') === '#' + entry.target.id
        );
      });
    }
  });
}, { threshold: 0.4 });

sections.forEach(s => sectionObserver.observe(s));

// ─── Auto-update download link from GitHub Releases ────────────────────────
(async () => {
  try {
    const res = await fetch('https://api.github.com/repos/robbiestokes21/dev-browser/releases/latest');
    if (!res.ok) return;
    const release = await res.json();

    const exe = release.assets?.find(a => a.name.toLowerCase().endsWith('.exe'));
    if (!exe) return;

    const btn     = document.getElementById('win-dl-btn');
    const version = document.getElementById('win-dl-version');
    const sizeMB  = Math.round(exe.size / 1024 / 1024);

    if (btn) btn.href = exe.browser_download_url;
    if (version) version.textContent = `${release.tag_name} · ${sizeMB} MB`;
  } catch {
    // silently fall back to the hardcoded href
  }
})();
