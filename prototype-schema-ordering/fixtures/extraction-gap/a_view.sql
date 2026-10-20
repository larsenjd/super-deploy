-- Functional notation: c.order_count means order_count(c). The extractor sees a
-- column reference, not a function call, so no edge to order_count is created.
-- The kind-priority tie-break (functions before views) happens to hide the gap;
-- an alternative valid order exposes it as a load failure.
create view customer_stats as select c.id, c.order_count from customers c;
