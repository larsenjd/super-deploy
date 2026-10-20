-- closes the customers <-> orders FK cycle
alter table customers add constraint customers_last_order_fk
  foreign key (last_order_id) references orders (id);
