// Form submission that also works inside a sandboxed preview.
//
// Some hosts embed the site in an iframe with sandbox="allow-scripts" and no
// "allow-forms". In that case the browser never fires the submit event, so the
// page's submit handlers do nothing. Here a click on a submit button cancels the
// native submission and dispatches the submit event itself. Enter in a text field
// clicks the default submit button, so it is covered too. Each submit runs once.
export function bindSubmitButtons(root = document) {
  for (const btn of root.querySelectorAll('form button[type="submit"]')) {
    btn.addEventListener('click', (e) => {
      const form = btn.form;
      if (!form) return;
      e.preventDefault();
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
  }
}
