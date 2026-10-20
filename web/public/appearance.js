// Runs synchronously before application CSS/React to avoid a light-theme flash.
(() => {
  let theme = 'system';
  try {
    const saved = localStorage.getItem('dataqore.ui.theme');
    if (['light', 'dark', 'system'].includes(saved)) theme = saved;
  } catch { /* Private/blocked storage uses the system preference. */ }
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
})();
