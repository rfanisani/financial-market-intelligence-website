import { redirect } from 'next/navigation';

// The real site is the static vanilla build in public/ (deployed to GitHub Pages).
// This route only forwards the v0 preview to the English dashboard.
export default function Page() {
  redirect('/en/index.html');
}
