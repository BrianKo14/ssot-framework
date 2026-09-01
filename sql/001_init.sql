create domain email as text;

create table cliente (
  id      integer primary key,
  nombre  text not null,
  email   email
);
insert into cliente (id, nombre, email) values (1, 'Ada', 'ada@example.com');
