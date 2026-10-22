import Link from "next/link";

export default function NotFound() {
  return (
    <div className="empty">
      <p>That page does not exist, or the work is no longer listed.</p>
      <p><Link href="/">Browse all work</Link></p>
    </div>
  );
}
