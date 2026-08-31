-- Two new split_kind values, added on their own so nothing in this same
-- migration file can use them yet — Postgres will not let a new enum value
-- be referenced in the same transaction that adds it (each file here runs as
-- one transaction), so 0014 is where 'adjustment' and 'itemized' start being
-- used.
--
-- 'adjustment': start from an equal split, then nudge each person's share up
-- or down by a hand-entered amount — the split-method picker's fifth option,
-- alongside equal/exact/shares/percent.
--
-- 'itemized': expenses.split_kind only, meaning "derive the split from
-- expense_items/expense_item_splits" (see 0014). Never valid on
-- expense_items.split_kind itself, which sticks to the four picker kinds
-- plus 'adjustment' — the enum doesn't enforce that distinction, discipline
-- in the app layer does, same trade-off recurring_expenses already makes by
-- reusing this one shared type instead of a second narrower enum.
alter type split_kind add value if not exists 'adjustment';
alter type split_kind add value if not exists 'itemized';
