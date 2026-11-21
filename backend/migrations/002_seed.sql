INSERT INTO centres VALUES ('c-hyd-1','Charminar Skill Centre','Hyderabad'),('c-wgl-1','Warangal Skill Centre','Warangal') ON CONFLICT DO NOTHING;
INSERT INTO users(id,name,role,district,centre_id) VALUES
 ('anika','Anika','CENTRE',NULL,'c-hyd-1'),
 ('ravi','Ravi (other centre)','CENTRE',NULL,'c-wgl-1'),
 ('dev','Dev','DISTRICT','Hyderabad',NULL),
 ('meera','Meera','DISTRICT','Hyderabad',NULL),
 ('kabir','Kabir','DISTRICT','Hyderabad',NULL),
 ('neha','Neha','QUALITY',NULL,NULL),
 ('farah','Farah','STATE',NULL,NULL) ON CONFLICT DO NOTHING;
INSERT INTO batches(id,centre_id,title,course,status,size,created_by)
 VALUES ('00000000-0000-4000-8000-000000000001','c-hyd-1','Sample batch - Retail Sales Associate','Retail Sales Associate','DRAFT',5,'anika') ON CONFLICT DO NOTHING;
INSERT INTO candidates(batch_id,name,phone)
 SELECT '00000000-0000-4000-8000-000000000001', n, '+91990000000'||i
 FROM unnest(ARRAY['Asha Reddy','Bilal Khan','Chitra Nair','Dinesh Rao','Esha Patel']) WITH ORDINALITY t(n,i) ON CONFLICT DO NOTHING;
