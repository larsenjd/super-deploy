# 03: The override hint for a routine body points inside the body

**What to build:** When a risk rule refuses something inside a routine body, the hint says where the marker actually goes, and a marker written inside the body is reported instead of silently ignored.

Today, for

```sql
create function f(source text) returns void
language plpgsql as $$
begin
  -- OVERRIDE SUPER-DEPLOY REFUSAL: loads tables named by the caller
  execute format('select 1 from %s', source);
end
$$;
```

the violation is `plpgsql-dynamic-sql` at line 5 (the `EXECUTE`), with the hint "override the refusal with "-- OVERRIDE SUPER-DEPLOY REFUSAL: <reason>" on the line before it". That is exactly where the marker is; it is ignored because markers inside dollar-quoted bodies never count (`sql-analysis/overrides.ts`). Following the hint loops forever. The marker belongs on the line before `create function` (line 1).

Indentation itself is fine: spaces, tabs, CRLF and trailing whitespace around a marker on its own line all work, in the desired schema and in deploy-time files (checked while triaging).

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] When the refused construct is inside a routine body (the finding has its own line), the hint names the statement and its first line: "…on the line before `create function f` (line 1)". The violation keeps the construct's own line.
- [ ] A comment inside a routine body that looks like a marker is reported as `override-misplaced`, at its line, saying the marker goes on the line before the statement that creates the routine.
- [ ] Marker text inside a string literal, in a body or not, is still ignored. The test "ignores marker text inside a string or a routine body" is split accordingly.
- [ ] A marker on the line before the `CREATE` statement still overrides the body's violations and is recorded with its object (existing tests keep passing).
- [ ] Unit tests cover the example above, both for the hint and for the misplaced marker, and add the indentation cases: a tab, an indented marker and statement, and CRLF line endings.
