import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { download, get, post, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, titleCase } from '../lib/format';
import {
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  PageHeader,
  Spinner,
  TableWrap,
} from '../components/ui';

const CATEGORIES = ['ASSET', 'STATIONERY', 'LAB_EQUIPMENT', 'FURNITURE', 'OTHER'] as const;

interface Item {
  id: string;
  name: string;
  category: string;
  sku: string | null;
  unit: string;
  quantity: number;
  reorderLevel: number;
  unitCost: string | null;
  location: string | null;
}

interface ItemForm {
  name: string;
  category: string;
  sku?: string;
  unit: string;
  quantity: number;
  reorderLevel: number;
  unitCost?: number;
  location?: string;
}

export function InventoryPage() {
  const { can, user } = useAuth();
  const queryClient = useQueryClient();
  const currency = user?.school?.currency ?? 'TZS';

  const [category, setCategory] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [movementFor, setMovementFor] = useState<Item | null>(null);
  const [direction, setDirection] = useState<'IN' | 'OUT'>('IN');
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState('');

  const query = qs({ category, pageSize: 200 });
  const items = useQuery({
    queryKey: ['inventory', query],
    queryFn: () => get<{ data: Item[] }>(`/inventory/items${query}`),
  });

  const form = useForm<ItemForm>({
    defaultValues: { category: 'STATIONERY', unit: 'piece', quantity: 0, reorderLevel: 0 },
  });

  const create = useMutation({
    mutationFn: (values: ItemForm) =>
      post('/inventory/items', {
        ...values,
        quantity: Number(values.quantity),
        reorderLevel: Number(values.reorderLevel),
        unitCost: values.unitCost ? Number(values.unitCost) : null,
        sku: values.sku || null,
        location: values.location || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      setShowForm(false);
      form.reset({ category: 'STATIONERY', unit: 'piece', quantity: 0, reorderLevel: 0 });
    },
  });

  const move = useMutation({
    mutationFn: (itemId: string) =>
      post(`/inventory/items/${itemId}/movements`, {
        direction,
        quantity: Number(quantity),
        reason: reason || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      setMovementFor(null);
      setQuantity(1);
      setReason('');
    },
  });

  const lowStock = items.data?.data.filter((i) => i.quantity <= i.reorderLevel) ?? [];

  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle="Assets, stationery, laboratory equipment and furniture"
        actions={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => download('/reports/inventory?format=csv', 'inventory.csv')}
            >
              Export CSV
            </button>
            {can('inventory:manage') && (
              <button type="button" className="btn-primary" onClick={() => setShowForm(true)}>
                Add item
              </button>
            )}
          </>
        }
      />

      {lowStock.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <strong>{lowStock.length} item(s)</strong> are at or below their reorder level:{' '}
          {lowStock
            .slice(0, 3)
            .map((i) => i.name)
            .join(', ')}
          {lowStock.length > 3 ? '…' : ''}
        </div>
      )}

      <Card padded={false}>
        <div className="border-b border-slate-200 p-4">
          <select
            className="input sm:max-w-[220px]"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Filter by category"
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {titleCase(c)}
              </option>
            ))}
          </select>
        </div>

        {items.isLoading ? (
          <Spinner />
        ) : items.error ? (
          <div className="p-5">
            <ErrorNote error={items.error} />
          </div>
        ) : items.data?.data.length === 0 ? (
          <EmptyState title="No inventory items" />
        ) : (
          <TableWrap>
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th>SKU</th>
                  <th className="text-right">In stock</th>
                  <th className="text-right">Reorder at</th>
                  <th className="text-right">Unit cost</th>
                  <th>Location</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.data?.data.map((item) => {
                  const low = item.quantity <= item.reorderLevel;
                  return (
                    <tr key={item.id}>
                      <td className="font-medium text-slate-900">{item.name}</td>
                      <td>{titleCase(item.category)}</td>
                      <td className="font-mono text-xs">{item.sku ?? '—'}</td>
                      <td className={`text-right ${low ? 'font-semibold text-amber-700' : ''}`}>
                        {item.quantity} {item.unit}
                      </td>
                      <td className="text-right text-slate-500">{item.reorderLevel}</td>
                      <td className="text-right">
                        {item.unitCost ? money(item.unitCost, currency) : '—'}
                      </td>
                      <td>{item.location ?? '—'}</td>
                      <td className="text-right">
                        {can('inventory:manage') && (
                          <button
                            type="button"
                            className="text-sm text-brand-700 hover:underline"
                            onClick={() => setMovementFor(item)}
                          >
                            Adjust stock
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

      {showForm && (
        <Modal title="Add an inventory item" onClose={() => setShowForm(false)}>
          <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="space-y-4" noValidate>
            {create.error != null && <ErrorNote error={create.error} />}
            <Field label="Item name" required>
              <input className="input" {...form.register('name', { required: true })} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Category" required>
                <select className="input" {...form.register('category', { required: true })}>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {titleCase(c)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Unit" required>
                <input className="input" placeholder="piece, box, ream" {...form.register('unit', { required: true })} />
              </Field>
              <Field label="Opening quantity" required>
                <input
                  type="number"
                  min={0}
                  className="input"
                  {...form.register('quantity', { required: true, valueAsNumber: true })}
                />
              </Field>
              <Field label="Reorder level" required>
                <input
                  type="number"
                  min={0}
                  className="input"
                  {...form.register('reorderLevel', { required: true, valueAsNumber: true })}
                />
              </Field>
              <Field label="Unit cost">
                <input
                  type="number"
                  min={0}
                  step={100}
                  className="input"
                  {...form.register('unitCost', { valueAsNumber: true })}
                />
              </Field>
              <Field label="SKU">
                <input className="input" {...form.register('sku')} />
              </Field>
              <Field label="Storage location">
                <input className="input" placeholder="Store room A" {...form.register('location')} />
              </Field>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={create.isPending}>
                Add item
              </button>
            </div>
          </form>
        </Modal>
      )}

      {movementFor && (
        <Modal title={`Adjust stock — ${movementFor.name}`} onClose={() => setMovementFor(null)}>
          {move.error != null && (
            <div className="mb-4">
              <ErrorNote error={move.error} />
            </div>
          )}
          <p className="mb-4 text-sm text-slate-600">
            Currently in stock: <strong>{movementFor.quantity} {movementFor.unit}</strong>
          </p>
          <div className="space-y-4">
            <Field label="Direction" required>
              <select
                className="input"
                value={direction}
                onChange={(e) => setDirection(e.target.value as 'IN' | 'OUT')}
              >
                <option value="IN">Stock in (received)</option>
                <option value="OUT">Stock out (issued)</option>
              </select>
            </Field>
            <Field label="Quantity" required>
              <input
                type="number"
                min={1}
                className="input"
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
              />
            </Field>
            <Field label="Reason">
              <input
                className="input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Issued to Form 2 · damaged · purchased"
              />
            </Field>
            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
              <button type="button" className="btn-secondary" onClick={() => setMovementFor(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={move.isPending || quantity < 1}
                onClick={() => move.mutate(movementFor.id)}
              >
                Record movement
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
