"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="empty">
      <p>Something went wrong loading this page.</p>
      <p>
        <button className="button" type="button" onClick={reset}>Try again</button>
      </p>
    </div>
  );
}
