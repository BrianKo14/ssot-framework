create table cliente (
  id      integer primary key,
  nombre  text not null,
  email   text
);
insert into cliente (id, nombre, email) values (1, 'Ada', 'ada@example.com');