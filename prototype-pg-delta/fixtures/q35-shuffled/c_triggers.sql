create trigger orders_touch before update on orders
  for each row execute function touch_updated_at();
