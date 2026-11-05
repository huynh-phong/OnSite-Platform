import { useState } from 'react';
import { Alert, Badge, Card } from '../shared/ui';
import { api, explainError, type Product } from './api';

type Check = 'NO_PRODUCT' | 'LOW_CONFIDENCE' | 'UNIT_MISMATCH';

export interface DraftLine {
  sku_id: string | null;
  name: string | null;
  quantity: number;
  unit: string | null;
  unit_text: string;
  stated_unit: string | null;
  source_text: string;
  confidence: number;
  reason: string;
  checks: Check[];
}

export interface OrderDraft {
  lines: DraftLine[];
  dropped_lines: number;
  contact_details_removed: number;
  model: string;
  draft_only: true;
}

const CHECK_TEXT: Record<Check, string> = {
  NO_PRODUCT: 'No product matched: choose one',
  LOW_CONFIDENCE: 'Not sure: check product and quantity',
  UNIT_MISMATCH: 'Different unit: the quantity is not converted',
};

interface Row {
  sku: string;
  quantity: number;
  include: boolean;
  line: DraftLine;
}

/**
 * Pastes a contractor's message, lets the AI propose order lines, and makes the person check them. Only
 * ticked lines go into the cart, and the cart is still ordered the normal way, with stock checked then.
 */
export function OrderReader({ products, onAdd }: { products: Product[]; onAdd: (lines: { sku: string; quantity: number }[]) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [added, setAdded] = useState<number | null>(null);

  const read = async () => {
    setBusy(true);
    setError(null);
    setAdded(null);
    try {
      const result = await api<OrderDraft>('/orders/parse', { method: 'POST', body: { text } });
      setDraft(result);
      // A line is ticked only when nothing needs checking. Everything else waits for the person.
      setRows(result.lines.map((line) => ({ sku: line.sku_id ?? '', quantity: line.quantity, include: line.checks.length === 0, line })));
    } catch (failure) {
      setDraft(null);
      setError(explainError(failure));
    }
    setBusy(false);
  };
  const update = (index: number, patch: Partial<Row>) => setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const ready = rows.filter((row) => row.include && row.sku && row.quantity > 0);
  const add = () => {
    onAdd(ready.map((row) => ({ sku: row.sku, quantity: row.quantity })));
    setAdded(ready.length);
    setDraft(null);
    setRows([]);
    setText('');
  };

  return (
    <Card title="Paste an order message" actions={<Badge tone="info">AI reads, you check</Badge>}>
      <div className="card-body stack small">
        <label className="field">
          Order text, as written in an email or message
          <textarea
            rows={3}
            maxLength={2000}
            value={text}
            placeholder="20 säckar Byggcement 25kg, 2 pall gips 13mm 900x2400. Leverans tis 07:00."
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="row">
          <button type="button" className="btn" disabled={busy || !text.trim()} onClick={() => void read()}>
            {busy ? 'Reading…' : 'Read with AI'}
          </button>
          <span className="muted">E-mail addresses and phone numbers are removed before the text is sent. Nothing is ordered here.</span>
        </div>
        {error && <Alert tone="warn">{error}</Alert>}
        {added !== null && <Alert tone="ok">{added} line{added === 1 ? '' : 's'} added to your order. Check the order, then place it.</Alert>}
        {draft && (
          <>
            {draft.contact_details_removed > 0 && <p className="muted">{draft.contact_details_removed} contact detail(s) were removed before reading.</p>}
            {draft.dropped_lines > 0 && (
              <Alert tone="warn">{draft.dropped_lines} suggested line(s) did not quote your text exactly and were left out. Add those from the catalog.</Alert>
            )}
            {rows.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Add</th>
                      <th>From your text</th>
                      <th>Product</th>
                      <th className="num">Quantity</th>
                      <th>Check</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => {
                      const product = products.find((candidate) => candidate.sku_id === row.sku);
                      return (
                        <tr key={`${row.line.source_text}-${index}`}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Add line ${index + 1}`}
                              checked={row.include}
                              disabled={!row.sku}
                              onChange={(e) => update(index, { include: e.target.checked })}
                            />
                          </td>
                          <td>“{row.line.source_text}”</td>
                          <td>
                            <select aria-label={`Product for line ${index + 1}`} value={row.sku} onChange={(e) => update(index, { sku: e.target.value })}>
                              <option value="">Choose a product</option>
                              {products.map((option) => (
                                <option key={option.sku_id} value={option.sku_id}>
                                  {option.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="num">
                            <input
                              type="number"
                              min={1}
                              aria-label={`Quantity for line ${index + 1}`}
                              value={row.quantity}
                              onChange={(e) => update(index, { quantity: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                            />
                            <div className="muted">{product?.base_unit ?? ''}</div>
                          </td>
                          <td>
                            {row.line.checks.length ? (
                              row.line.checks.map((check) => (
                                <div key={check}>
                                  <Badge tone="warn">{CHECK_TEXT[check]}</Badge>
                                  {check === 'UNIT_MISMATCH' && (
                                    <div className="muted">
                                      You wrote “{row.line.unit_text}”; this is sold per {row.line.unit}.
                                    </div>
                                  )}
                                </div>
                              ))
                            ) : (
                              <span className="muted">{Math.round(row.line.confidence * 100)}% sure</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">No order lines were found in the text. Add the products from the catalog.</p>
            )}
            {rows.length > 0 && (
              <div className="row">
                <button type="button" className="btn primary" disabled={!ready.length} onClick={add}>
                  Add {ready.length} checked line{ready.length === 1 ? '' : 's'} to the order
                </button>
                <span className="muted">Read by {draft.model}. Stock and prices are checked when you place the order, not by the AI.</span>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
