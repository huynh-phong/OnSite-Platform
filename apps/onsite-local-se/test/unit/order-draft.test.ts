import { describe, expect, it } from 'vitest';
import { MockLlmProvider } from '../../src/connectors/llm.js';
import { redactContactDetails, validateOrderDraft, type DraftCatalogEntry } from '../../src/modules/intake/order-draft.js';

const catalog: DraftCatalogEntry[] = [
  { sku_id: 'SE-CEM-025', name: 'Portland cement 25 kg bag', unit: 'bag' },
  { sku_id: 'SE-CEM-RPD-025', name: 'Rapid-set cement 25 kg bag', unit: 'bag' },
  { sku_id: 'SE-GYP-13-2400', name: 'Gypsum board 13 mm 900x2400', unit: 'sheet' },
  { sku_id: 'SE-GYP-13-2700', name: 'Gypsum board 13 mm 1200x2700', unit: 'sheet' },
  { sku_id: 'SE-TIM-4595', name: 'Structural timber C24 45x95 mm', unit: 'm' },
  { sku_id: 'SE-INS-GW-70', name: 'Glass wool roll 70 mm', unit: 'roll' },
];

const line = (overrides: Record<string, unknown> = {}) => ({
  sku_id: 'SE-CEM-025',
  quantity: 20,
  unit_text: 'säckar',
  source_text: '20 säckar Byggcement 25kg',
  confidence: 0.9,
  reason: 'Matches the name',
  ...overrides,
});
const MESSAGE = 'Hej! Vi behöver 20 säckar Byggcement 25kg och 2 pall gips 13mm 900x2400. Leverans tis 07:00.';

describe('removing contact details before the text leaves Local SE', () => {
  it('removes e-mail addresses, Swedish phone numbers and personal identity numbers', () => {
    const { text, removed } = redactContactDetails(
      'Ring Erik på 070-123 45 67 eller +46 8 123 456 78, erik@nordbygg.se. Pnr 19850101-1234. 20 säckar cement.',
    );
    expect(text).not.toMatch(/070|123 45|nordbygg|1985/);
    expect(text).toContain('20 säckar cement');
    expect(removed).toBe(4);
  });

  it('leaves quantities, sizes and times alone', () => {
    expect(redactContactDetails(MESSAGE)).toEqual({ text: MESSAGE, removed: 0 });
  });
});

describe('guardrails on the reader output', () => {
  it('keeps a line that quotes the message, with no checks when all is clear', () => {
    const draft = validateOrderDraft(MESSAGE, catalog, { lines: [line()] });
    expect(draft).toEqual({
      dropped: 0,
      lines: [
        expect.objectContaining({ sku_id: 'SE-CEM-025', quantity: 20, unit: 'bag', stated_unit: 'bag', checks: [] }),
      ],
    });
  });

  it('accepts the provider answer as a JSON string', () => {
    expect(validateOrderDraft(MESSAGE, catalog, JSON.stringify({ lines: [line()] }))?.lines).toHaveLength(1);
  });

  it('drops an invented quote, an invented quantity, a fractional or absurd quantity, and a bad confidence', () => {
    const draft = validateOrderDraft(MESSAGE, catalog, {
      lines: [
        line({ source_text: '200 säckar cement' }),
        line({ quantity: 200 }),
        line({ quantity: 2.5 }),
        line({ quantity: 0 }),
        line({ confidence: 1.4 }),
        line({ sku_id: 42 }),
        line(),
      ],
    });
    expect(draft?.dropped).toBe(6);
    expect(draft?.lines).toHaveLength(1);
  });

  it('flags a product that is not in the catalog instead of trusting it', () => {
    const [flagged] = validateOrderDraft(MESSAGE, catalog, { lines: [line({ sku_id: 'SE-MADE-UP' })] })!.lines;
    expect(flagged).toMatchObject({ sku_id: null, name: null, checks: ['NO_PRODUCT'] });
  });

  it('flags a unit that differs from how the product is sold, and never converts it', () => {
    const [flagged] = validateOrderDraft(MESSAGE, catalog, {
      lines: [line({ sku_id: 'SE-GYP-13-2400', quantity: 2, unit_text: 'pall', source_text: '2 pall gips 13mm 900x2400' })],
    })!.lines;
    expect(flagged).toMatchObject({ quantity: 2, unit: 'sheet', stated_unit: 'pallet', checks: ['UNIT_MISMATCH'] });
  });

  it('flags confidence below 0.7, the Round 1 threshold', () => {
    const [flagged] = validateOrderDraft(MESSAGE, catalog, { lines: [line({ confidence: 0.69 })] })!.lines;
    expect(flagged!.checks).toEqual(['LOW_CONFIDENCE']);
  });

  it('refuses output that is not a list of lines at all', () => {
    expect(validateOrderDraft(MESSAGE, catalog, 'not json')).toBeUndefined();
    expect(validateOrderDraft(MESSAGE, catalog, { lines: 'x' })).toBeUndefined();
    expect(validateOrderDraft(MESSAGE, catalog, null)).toBeUndefined();
    expect(validateOrderDraft(MESSAGE, catalog, { lines: Array.from({ length: 51 }, () => line()) })).toBeUndefined();
  });
});

describe('the mock order reader (keyword rules, not a model)', () => {
  const read = async (text: string) => {
    const output = await new MockLlmProvider().parseOrder({ text, catalog });
    return validateOrderDraft(text, catalog, output)!;
  };

  it('reads the Round 2 golden journey message, ignoring the delivery time', async () => {
    const { lines, dropped } = await read(MESSAGE);
    expect(dropped).toBe(0);
    expect(lines.map((entry) => [entry.sku_id, entry.quantity, entry.checks])).toEqual([
      ['SE-CEM-025', 20, []],
      ['SE-GYP-13-2400', 2, ['UNIT_MISMATCH']],
    ]);
  });

  it('takes the quantity, not a size, and asks a person when two products fit equally well', async () => {
    const { lines } = await read('10 st gipsskivor 13 mm');
    expect(lines[0]).toMatchObject({ quantity: 10, checks: ['LOW_CONFIDENCE'] });
  });

  it('marks a line it cannot match, and skips text with no quantity', async () => {
    const { lines } = await read('5 st skruvdragare\nTack på förhand');
    expect(lines).toEqual([expect.objectContaining({ quantity: 5, sku_id: null, checks: ['NO_PRODUCT', 'LOW_CONFIDENCE'] })]);
  });
});
