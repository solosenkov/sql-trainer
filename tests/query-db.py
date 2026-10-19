import sqlite3,json,sys
body=json.load(sys.stdin)
con=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
try:
 cur=con.execute(body['sql'],body.get('params',[]));print(json.dumps({'columns':[c[0] for c in cur.description],'rows':cur.fetchall()},ensure_ascii=False))
finally:con.close()
