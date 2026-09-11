import './globals.css';
export const metadata = { title: 'Inditress Board', description: 'Inditress project tracker' };
export default function RootLayout({ children }) {
  return (<html lang="en"><body>{children}</body></html>);
}
