import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { get, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, money } from '../lib/format';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  PageHeader,
  Pagination,
  Spinner,
  TableWrap,
} from '../components/ui';
import type { Paginated, Student } from '../lib/types';

interface Book {
  id: string;
  title: string;
  author: string | null;
  isbn: string | null;
  barcode: string | null;
  category: string | null;
  shelf: string | null;
  totalCopies: number;
  availableCopies: number;
}

interface Loan {
  id: string;
  borrowedAt: string;
  dueDate: string;
  returnedAt: string | null;
  status: string;
  fineAmount: string;
  borrowerName: string | null;
  book: { id: string; title: string; author: string | null };
  student: { id: string; admissionNumber: string; firstName: string; lastName: string } | null;
}

interface BookForm {
  title: string;
  author?: string;
  isbn?: string;
  barcode?: string;
  category?: string;
  shelf?: string;
  totalCopies: number;
}

export function LibraryPage() {
  const { can, user } = useAuth();
  const queryClient = useQueryClient();
  const currency = user?.school?.currency ?? 'TZS';

  const [tab, setTab] = useState<'books' | 'loans'>('books');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [showBook, setShowBook] = useState(false);
  const [issuing, setIssuing] = useState<Book | null>(null);
  const [studentSearch, setStudentSearch] = useState('');

  const booksQuery = qs({ page, pageSize: 25, search });
  const books = useQuery({
    queryKey: ['books', booksQuery],
    queryFn: () => get<Paginated<Book>>(`/library/books${booksQuery}`),
    enabled: tab === 'books',
  });

  const loans = useQuery({
    queryKey: ['loans'],
    queryFn: () => get<Paginated<Loan>>('/library/loans?pageSize=100'),
    enabled: tab === 'loans',
  });

  const students = useQuery({
    queryKey: ['students', 'search', studentSearch],
    queryFn: () => get<Paginated<Student>>(`/students${qs({ search: studentSearch, pageSize: 8 })}`),
    enabled: Boolean(issuing) && studentSearch.length >= 2,
  });

  const bookForm = useForm<BookForm>({ defaultValues: { totalCopies: 1 } });

  const addBook = useMutation({
    mutationFn: (values: BookForm) =>
      post('/library/books', {
        ...values,
        totalCopies: Number(values.totalCopies),
        author: values.author || null,
        isbn: values.isbn || null,
        barcode: values.barcode || null,
        category: values.category || null,
        shelf: values.shelf || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['books'] });
      setShowBook(false);
      bookForm.reset({ totalCopies: 1 });
    },
  });

  const issueForm = useForm<{ studentId: string; dueDate: string }>();

  const issue = useMutation({
    mutationFn: (values: { studentId: string; dueDate: string }) =>
      post('/library/loans', {
        bookId: issuing?.id,
        studentId: values.studentId,
        dueDate: values.dueDate,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['books'] });
      void queryClient.invalidateQueries({ queryKey: ['loans'] });
      setIssuing(null);
      setStudentSearch('');
      issueForm.reset();
    },
  });

  const returnBook = useMutation({
    mutationFn: (loanId: string) => post(`/library/loans/${loanId}/return`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['loans'] });
      void queryClient.invalidateQueries({ queryKey: ['books'] });
    },
  });

  return (
    <>
      <PageHeader
        title="Library"
        subtitle="Catalogue, borrowing and returns"
        actions={
          can('library:manage') && (
            <button type="button" className="btn-primary" onClick={() => setShowBook(true)}>
              Add book
            </button>
          )
        }
      />

      <div className="mb-5 flex gap-1 border-b border-slate-200">
        {(
          [
            ['books', 'Catalogue'],
            ['loans', 'Loans'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === value
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'books' && (
        <Card padded={false}>
          <div className="border-b border-slate-200 p-4">
            <input
              className="input sm:max-w-xs"
              placeholder="Search title, author, ISBN or barcode"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              aria-label="Search the catalogue"
            />
          </div>
          {books.isLoading ? (
            <Spinner />
          ) : books.error ? (
            <div className="p-5">
              <ErrorNote error={books.error} />
            </div>
          ) : books.data?.data.length === 0 ? (
            <EmptyState title="No books found" />
          ) : (
            <>
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Author</th>
                      <th>Category</th>
                      <th>Shelf</th>
                      <th className="text-center">Available</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {books.data?.data.map((b) => (
                      <tr key={b.id}>
                        <td className="font-medium text-slate-900">
                          {b.title}
                          {b.isbn && <span className="block text-xs text-slate-400">{b.isbn}</span>}
                        </td>
                        <td>{b.author ?? '—'}</td>
                        <td>{b.category ?? '—'}</td>
                        <td className="font-mono text-xs">{b.shelf ?? '—'}</td>
                        <td className="text-center">
                          <span
                            className={
                              b.availableCopies === 0 ? 'font-medium text-red-700' : 'text-slate-700'
                            }
                          >
                            {b.availableCopies}/{b.totalCopies}
                          </span>
                        </td>
                        <td className="text-right">
                          {can('library:manage') && b.availableCopies > 0 && (
                            <button
                              type="button"
                              className="text-sm text-brand-700 hover:underline"
                              onClick={() => setIssuing(b)}
                            >
                              Issue
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              {books.data && (
                <Pagination
                  page={books.data.meta.page}
                  totalPages={books.data.meta.totalPages}
                  total={books.data.meta.total}
                  onChange={setPage}
                />
              )}
            </>
          )}
        </Card>
      )}

      {tab === 'loans' && (
        <Card padded={false}>
          {loans.isLoading ? (
            <Spinner />
          ) : loans.data?.data.length === 0 ? (
            <EmptyState title="No loans recorded" />
          ) : (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Book</th>
                    <th>Borrower</th>
                    <th>Borrowed</th>
                    <th>Due</th>
                    <th>Status</th>
                    <th className="text-right">Fine</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {loans.data?.data.map((loan) => {
                    const overdue = !loan.returnedAt && new Date(loan.dueDate) < new Date();
                    return (
                      <tr key={loan.id}>
                        <td className="font-medium">{loan.book.title}</td>
                        <td>
                          {loan.student
                            ? `${loan.student.firstName} ${loan.student.lastName}`
                            : (loan.borrowerName ?? '—')}
                          {loan.student && (
                            <span className="block text-xs text-slate-400">
                              {loan.student.admissionNumber}
                            </span>
                          )}
                        </td>
                        <td>{date(loan.borrowedAt)}</td>
                        <td className={overdue ? 'font-medium text-red-700' : ''}>
                          {date(loan.dueDate)}
                        </td>
                        <td>
                          <Badge status={overdue ? 'OVERDUE' : loan.status} />
                        </td>
                        <td className="text-right">
                          {Number(loan.fineAmount) > 0 ? money(loan.fineAmount, currency) : '—'}
                        </td>
                        <td className="text-right">
                          {can('library:manage') && !loan.returnedAt && (
                            <button
                              type="button"
                              className="text-sm text-brand-700 hover:underline"
                              disabled={returnBook.isPending}
                              onClick={() => returnBook.mutate(loan.id)}
                            >
                              Return
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      )}

      {showBook && (
        <Modal title="Add a book" onClose={() => setShowBook(false)}>
          <form
            onSubmit={bookForm.handleSubmit((v) => addBook.mutate(v))}
            className="space-y-4"
            noValidate
          >
            {addBook.error != null && <ErrorNote error={addBook.error} />}
            <Field label="Title" required>
              <input className="input" {...bookForm.register('title', { required: true })} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Author">
                <input className="input" {...bookForm.register('author')} />
              </Field>
              <Field label="Category">
                <input className="input" placeholder="Sciences" {...bookForm.register('category')} />
              </Field>
              <Field label="ISBN">
                <input className="input" {...bookForm.register('isbn')} />
              </Field>
              <Field label="Barcode">
                <input className="input" {...bookForm.register('barcode')} />
              </Field>
              <Field label="Shelf">
                <input className="input" {...bookForm.register('shelf')} />
              </Field>
              <Field label="Number of copies" required>
                <input
                  type="number"
                  min={1}
                  className="input"
                  {...bookForm.register('totalCopies', { required: true, valueAsNumber: true })}
                />
              </Field>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setShowBook(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={addBook.isPending}>
                Add book
              </button>
            </div>
          </form>
        </Modal>
      )}

      {issuing && (
        <Modal title={`Issue "${issuing.title}"`} onClose={() => setIssuing(null)}>
          <form
            onSubmit={issueForm.handleSubmit((v) => issue.mutate(v))}
            className="space-y-4"
            noValidate
          >
            {issue.error != null && <ErrorNote error={issue.error} />}
            <Field label="Find the student" required>
              <input
                className="input"
                value={studentSearch}
                onChange={(e) => setStudentSearch(e.target.value)}
                placeholder="Name or admission number"
                autoFocus
              />
            </Field>
            {studentSearch.length >= 2 && (
              <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-200">
                {students.isLoading ? (
                  <Spinner label="Searching…" />
                ) : students.data?.data.length === 0 ? (
                  <p className="p-4 text-sm text-slate-500">No matches.</p>
                ) : (
                  <ul>
                    {students.data?.data.map((s) => (
                      <li key={s.id}>
                        <label className="flex cursor-pointer items-center gap-3 border-b border-slate-100 px-4 py-2 text-sm last:border-0 hover:bg-slate-50">
                          <input
                            type="radio"
                            value={s.id}
                            {...issueForm.register('studentId', { required: true })}
                          />
                          <span>
                            {s.firstName} {s.lastName}
                            <span className="block text-xs text-slate-400">{s.admissionNumber}</span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <Field label="Return by" required>
              <input type="date" className="input" {...issueForm.register('dueDate', { required: true })} />
            </Field>
            <p className="text-xs text-slate-500">
              A student may hold up to 3 books at a time. Overdue returns accrue a daily fine.
            </p>
            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setIssuing(null)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={issue.isPending}>
                Issue book
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
