-- self-referencing FK, plus a node <-> leaf FK cycle closed by ALTER TABLE
alter table node add constraint node_best_leaf_fk foreign key (best_leaf_id) references leaf (id);
create table leaf (id int primary key, node_id int not null references node (id));
create table node (id int primary key, parent_id int references node (id), best_leaf_id int);
