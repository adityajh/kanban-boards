import './globals.css';
export const metadata = { title: 'Project Board', description: 'Client project boards' };
export default function RootLayout({ children }) {
  return (<html lang="en"><body>{children}</body></html>);
}
