create trigger docs_audit after insert or update on docs
  for each row when (should_audit(new.title))
  execute function audit_doc();
