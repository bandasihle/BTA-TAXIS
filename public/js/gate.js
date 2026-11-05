// Danki Driver opens on the welcome screen (loading, then sign in or continue as a
// passenger) once per visit, before anything else is drawn. A link straight to a rank
// (/#/gauteng/...) opens the rank. Loaded as a plain script at the top of the page.
try {
  if (!sessionStorage.getItem('dk:in') && location.hash.length < 3) location.replace('/login.html');
} catch (e) {
  /* storage blocked: let the visitor in rather than loop */
}
