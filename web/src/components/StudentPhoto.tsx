import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, upload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ErrorNote } from './ui';
import type { FileLink } from '../lib/types';

/**
 * A student's photograph, with the controls to set or clear it.
 *
 * The image URL is fetched rather than read off the student record, because
 * what the record holds is a reference to an object in a private bucket. The
 * signed URL that makes it readable lasts minutes, so it is refetched when the
 * page is opened rather than stored with the student.
 */
export function StudentPhoto({
  studentId,
  name,
  hasPhoto,
}: {
  studentId: string;
  name: string;
  hasPhoto: boolean;
}) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const canManage = can('students:manage');

  const photo = useQuery({
    queryKey: ['student', studentId, 'photo'],
    queryFn: () => get<FileLink>(`/students/${studentId}/photo`),
    enabled: hasPhoto,
    // The URL expires, so it is not worth keeping across a navigation.
    staleTime: 60_000,
    retry: false,
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['student', studentId] }),
      queryClient.invalidateQueries({ queryKey: ['student', studentId, 'photo'] }),
      queryClient.invalidateQueries({ queryKey: ['documents', 'usage'] }),
    ]);
  };

  const set = useMutation({
    mutationFn: (file: File) => upload<FileLink>(`/students/${studentId}/photo`, file),
    onSuccess: async () => {
      if (fileInput.current) fileInput.current.value = '';
      await refresh();
    },
  });

  const clear = useMutation({
    mutationFn: () => del(`/students/${studentId}/photo`),
    onSuccess: refresh,
  });

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div className="flex items-start gap-4">
      <div className="h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
        {photo.data?.url ? (
          <img
            src={photo.data.url}
            alt={`Photograph of ${name}`}
            className="h-full w-full object-cover"
          />
        ) : (
          // Initials rather than a generic silhouette: in a register of several
          // hundred, they are the faster thing to scan.
          <div
            className="flex h-full w-full items-center justify-center text-2xl font-semibold text-slate-400"
            aria-hidden="true"
          >
            {initials || '—'}
          </div>
        )}
      </div>

      {canManage && (
        <div className="min-w-0">
          <label className="label" htmlFor={`photo-${studentId}`}>
            Photograph
          </label>
          <input
            id={`photo-${studentId}`}
            ref={fileInput}
            type="file"
            className="input text-sm"
            accept="image/jpeg,image/png,image/webp"
            disabled={set.isPending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) set.mutate(file);
            }}
          />
          <p className="mt-1 text-xs text-slate-500">
            {set.isPending ? 'Uploading…' : 'JPEG, PNG or WebP.'}
          </p>

          {hasPhoto && (
            <button
              type="button"
              className="mt-2 text-sm text-red-700 hover:underline disabled:opacity-50"
              disabled={clear.isPending}
              onClick={() => {
                if (window.confirm('Remove this photograph?')) clear.mutate();
              }}
            >
              Remove photograph
            </button>
          )}

          {set.error != null && (
            <div className="mt-2">
              <ErrorNote error={set.error} />
            </div>
          )}
          {clear.error != null && (
            <div className="mt-2">
              <ErrorNote error={clear.error} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
