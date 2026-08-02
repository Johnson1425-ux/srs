import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="card p-10 text-center">
      <p className="text-sm font-semibold uppercase tracking-wide text-brand-600">404</p>
      <h1 className="mt-2 text-xl font-semibold text-slate-900">Page not found</h1>
      <p className="mt-2 text-sm text-slate-500">
        The page you are looking for does not exist or has been moved.
      </p>
      <Link to="/" className="btn-primary mt-6 inline-flex">
        Back to dashboard
      </Link>
    </div>
  );
}
