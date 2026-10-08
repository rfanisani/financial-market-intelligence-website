import { redirect } from 'next/navigation';

// The real site is the static vanilla build in public/ (deployed to GitHub Pages).
// This route only forwards the v0 preview to the Persian dashboard.
export default function Page() {
  redirect('/fa/index.html');
}
