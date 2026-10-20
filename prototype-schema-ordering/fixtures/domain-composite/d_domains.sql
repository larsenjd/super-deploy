create domain pos_pair as pair
  check ((value).a > 0 and (value).b > 0);
create domain pos_int as int check (value > 0);
comment on domain pos_pair is 'domain over a composite type';
