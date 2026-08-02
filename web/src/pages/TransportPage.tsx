import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, money } from '../lib/format';
import {
  Card,
  EmptyState,
  ErrorNote,
  Modal,
  PageHeader,
  Spinner,
  TableWrap,
} from '../components/ui';

interface Vehicle {
  id: string;
  plateNumber: string;
  model: string | null;
  capacity: number;
  insuranceExpiry: string | null;
  isActive: boolean;
  driver: { id: string; firstName: string; lastName: string; phone: string | null } | null;
  routes: Array<{ id: string; name: string }>;
}

interface Route {
  id: string;
  name: string;
  fare: string;
  stops: Array<{ name: string; pickupTime?: string }> | null;
  vehicle: { id: string; plateNumber: string; capacity: number } | null;
  _count: { allocations: number };
}

interface Manifest {
  name: string;
  vehicle: {
    plateNumber: string;
    driver: { firstName: string; lastName: string; phone: string | null } | null;
  } | null;
  allocations: Array<{
    id: string;
    pickupStop: string | null;
    student: {
      id: string;
      admissionNumber: string;
      firstName: string;
      lastName: string;
      enrollments: Array<{ schoolClass: { name: string } }>;
      guardianLinks: Array<{ guardian: { firstName: string; lastName: string; phone: string } }>;
    };
  }>;
}

export function TransportPage() {
  const { user } = useAuth();
  const currency = user?.school?.currency ?? 'TZS';
  const [manifestFor, setManifestFor] = useState<string | null>(null);

  const vehicles = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => get<{ data: Vehicle[] }>('/transport/vehicles'),
  });
  const routes = useQuery({
    queryKey: ['routes'],
    queryFn: () => get<{ data: Route[] }>('/transport/routes'),
  });
  const manifest = useQuery({
    queryKey: ['routes', manifestFor, 'manifest'],
    queryFn: () => get<Manifest>(`/transport/routes/${manifestFor}/manifest`),
    enabled: Boolean(manifestFor),
  });

  return (
    <>
      <PageHeader title="Transport" subtitle="School buses, routes, drivers and student allocation" />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Vehicles" padded={false}>
          {vehicles.isLoading ? (
            <Spinner />
          ) : vehicles.error ? (
            <div className="p-5">
              <ErrorNote error={vehicles.error} />
            </div>
          ) : vehicles.data?.data.length === 0 ? (
            <EmptyState title="No vehicles registered" />
          ) : (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Plate</th>
                    <th>Model</th>
                    <th>Driver</th>
                    <th className="text-right">Seats</th>
                    <th>Insurance</th>
                  </tr>
                </thead>
                <tbody>
                  {vehicles.data?.data.map((v) => {
                    const expiring =
                      v.insuranceExpiry &&
                      new Date(v.insuranceExpiry).getTime() - Date.now() < 30 * 86_400_000;
                    return (
                      <tr key={v.id}>
                        <td className="font-mono text-sm font-medium">{v.plateNumber}</td>
                        <td>{v.model ?? '—'}</td>
                        <td>
                          {v.driver ? (
                            <>
                              {v.driver.firstName} {v.driver.lastName}
                              {v.driver.phone && (
                                <span className="block text-xs text-slate-400">{v.driver.phone}</span>
                              )}
                            </>
                          ) : (
                            <span className="text-amber-700">Unassigned</span>
                          )}
                        </td>
                        <td className="text-right">{v.capacity}</td>
                        <td className={expiring ? 'font-medium text-red-700' : ''}>
                          {date(v.insuranceExpiry)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title="Routes" padded={false}>
          {routes.isLoading ? (
            <Spinner />
          ) : routes.data?.data.length === 0 ? (
            <EmptyState title="No routes configured" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {routes.data?.data.map((route) => {
                const capacity = route.vehicle?.capacity ?? 0;
                const used = route._count.allocations;
                return (
                  <li key={route.id} className="px-5 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-slate-900">{route.name}</p>
                        <p className="text-xs text-slate-500">
                          {route.vehicle?.plateNumber ?? 'No bus assigned'} ·{' '}
                          {money(route.fare, currency)} per term
                        </p>
                      </div>
                      <button
                        type="button"
                        className="text-sm text-brand-700 hover:underline"
                        onClick={() => setManifestFor(route.id)}
                      >
                        Manifest
                      </button>
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
                        <div
                          className={`h-full rounded-full ${used >= capacity && capacity > 0 ? 'bg-red-500' : 'bg-brand-500'}`}
                          style={{ width: capacity ? `${Math.min(100, (used / capacity) * 100)}%` : '0%' }}
                        />
                      </div>
                      <span className="text-xs text-slate-500">
                        {used}
                        {capacity ? `/${capacity}` : ''} students
                      </span>
                    </div>
                    {route.stops && route.stops.length > 0 && (
                      <ul className="mt-3 flex flex-wrap gap-2">
                        {route.stops.map((stop) => (
                          <li
                            key={stop.name}
                            className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                          >
                            {stop.name}
                            {stop.pickupTime ? ` · ${stop.pickupTime}` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {manifestFor && (
        <Modal title="Route manifest" onClose={() => setManifestFor(null)} wide>
          {manifest.isLoading ? (
            <Spinner />
          ) : manifest.error ? (
            <ErrorNote error={manifest.error} />
          ) : (
            <>
              <div className="mb-4">
                <p className="font-medium text-slate-900">{manifest.data?.name}</p>
                <p className="text-sm text-slate-500">
                  {manifest.data?.vehicle?.plateNumber ?? 'No bus'}
                  {manifest.data?.vehicle?.driver
                    ? ` · Driver: ${manifest.data.vehicle.driver.firstName} ${manifest.data.vehicle.driver.lastName}`
                    : ''}
                </p>
              </div>
              {manifest.data?.allocations.length === 0 ? (
                <EmptyState title="No students allocated to this route" />
              ) : (
                <TableWrap>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Student</th>
                        <th>Class</th>
                        <th>Pick-up</th>
                        <th>Guardian contact</th>
                      </tr>
                    </thead>
                    <tbody>
                      {manifest.data?.allocations.map((a) => (
                        <tr key={a.id}>
                          <td>
                            {a.student.firstName} {a.student.lastName}
                            <span className="block text-xs text-slate-400">
                              {a.student.admissionNumber}
                            </span>
                          </td>
                          <td>{a.student.enrollments[0]?.schoolClass.name ?? '—'}</td>
                          <td>{a.pickupStop ?? '—'}</td>
                          <td className="text-xs">
                            {a.student.guardianLinks[0]
                              ? `${a.student.guardianLinks[0].guardian.firstName} · ${a.student.guardianLinks[0].guardian.phone}`
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
