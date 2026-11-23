export default function Page() {
  return (
    <main>
      <h1>Asasa Gold Trading Demo</h1>
      <p>
        This deployment exposes a backend API only. Start at{' '}
        <code>/api/state</code>, then use <code>/api/quotes</code> to request a
        quote and <code>/api/quotes/:id/confirm</code> to stage it.
      </p>
    </main>
  );
}
