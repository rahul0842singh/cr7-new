import { MongoClient } from 'mongodb';

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function reportFilter(url) {
  const filter = {};
  const q = String(url.searchParams.get('q') || '').slice(0,100).trim();
  if (q) filter.$or = ['orderId','ip','city','region','country'].map(field => ({[field]:{$regex:escapeRegex(q),$options:'i'}}));
  for (const field of ['from','to']) {
    const value = url.searchParams.get(field);
    if (!value) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw Object.assign(new Error('Invalid date'),{status:400});
    filter.createdAt ||= {};
    filter.createdAt[field === 'from' ? '$gte' : '$lte'] = `${value}T${field === 'from' ? '00:00:00.000' : '23:59:59.999'}Z`;
  }
  return filter;
}

export async function openReportStore({ mongoUri = process.env.MONGODB_URI, databaseName = process.env.MONGODB_DB || 'cr7' } = {}) {
  if (!mongoUri) throw new Error('Set MONGODB_URI in .env.server or your hosting environment before starting the server.');
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(databaseName)) throw new Error('MONGODB_DB must contain only letters, numbers, underscores or hyphens.');
  const client = new MongoClient(mongoUri,{serverSelectionTimeoutMS:10000,connectTimeoutMS:10000,socketTimeoutMS:15000,maxPoolSize:10});
  try {
    await client.connect();
    const db = client.db(databaseName);
    await db.command({ping:1});
    const reports = db.collection('payment_reports');
    await reports.createIndexes([{key:{createdAt:-1,_id:-1},name:'reports_date'},{key:{orderId:1},name:'reports_order'}]);
    // Do not reset another running server's active lookups. Only expire stale ones.
    await reports.updateMany({locationStatus:'pending',createdAt:{$lt:new Date(Date.now()-60000).toISOString()}},{$set:{locationStatus:'unavailable'}});
    return {
      async insert(report) {
        try { await reports.insertOne({_id:report.id,...report}); return true; }
        catch(error) { if(error.code===11000) return false; throw error; }
      },
      async updateLocation(id,location) {
        await reports.updateOne({_id:id},{$set:{city:location.city,region:location.region,country:location.country,locationStatus:location.status}});
      },
      async exportRows(filter) {
        return reports.find(filter,{projection:{_id:0},maxTimeMS:10000}).sort({createdAt:-1,_id:-1}).limit(10001).toArray();
      },
      async dashboard(filter,page) {
        const distinct = field => [{$group:{_id:`$${field}`}},{$count:'count'}];
        const today = new Date().toISOString().slice(0,10)+'T00:00:00.000Z';
        const [result] = await reports.aggregate([
          {$match:filter},
          {$facet:{
            totalClicks:[{$count:'count'}],
            uniqueOrders:distinct('orderId'),
            uniqueIPs:distinct('ip'),
            countryCount:[{$match:{country:{$nin:['',null]}}},...distinct('country')],
            today:[{$match:{createdAt:{$gte:today}}},{$count:'count'}],
            days:[{$group:{_id:{$substrBytes:['$createdAt',0,10]},count:{$sum:1}}},{$sort:{_id:-1}},{$limit:14},{$sort:{_id:1}},{$project:{_id:0,day:'$_id',count:1}}],
            countries:[{$group:{_id:{$cond:[{$ne:['$country','']},'$country',{$cond:[{$eq:['$locationStatus','local']},'Local network','Unknown / pending']}]},count:{$sum:1}}},{$sort:{count:-1,_id:1}},{$limit:6},{$project:{_id:0,name:'$_id',count:1}}]
          }}
        ],{maxTimeMS:10000}).toArray();
        const rows=await reports.find(filter,{projection:{_id:0},maxTimeMS:10000}).sort({createdAt:-1,_id:-1}).skip((page-1)*25).limit(25).toArray();
        return {summary:{totalClicks:result.totalClicks[0]?.count || 0,uniqueOrders:result.uniqueOrders[0]?.count || 0,uniqueIPs:result.uniqueIPs[0]?.count || 0,countries:result.countryCount[0]?.count || 0,today:result.today[0]?.count || 0},days:result.days,countries:result.countries,rows,page,pageSize:25};
      },
      async importRows(rows) {
        if(!rows.length)return 0;
        const result=await reports.bulkWrite(rows.map(row=>({updateOne:{filter:{_id:row.id},update:{$setOnInsert:{...row,locationStatus:row.locationStatus==='pending'?'unavailable':row.locationStatus}},upsert:true}})),{ordered:false});
        return result.upsertedCount;
      },
      async ping(){await db.command({ping:1});},
      async close(){await client.close();}
    };
  } catch(error) { await client.close(); throw error; }
}
