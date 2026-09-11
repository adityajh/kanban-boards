// "/" normally redirects (next.config.js). If that redirect is removed, show nothing that
// hints at which clients exist.
export default function Home() {
  return (
    <div className="gate">
      <h1>Project Boards</h1>
      <p>Open your board from the link you were given.</p>
    </div>
  );
}
