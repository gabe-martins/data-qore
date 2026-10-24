import { loadConfig } from './config.js';
import { database } from './db.js';
import { databaseFailure } from './diagnostics.js';
let db:ReturnType<typeof database>|undefined;
try {
  db=database(loadConfig().databaseUrl);
  const identity=await db.$queryRaw<{current_user:string;current_database:string}[]>`SELECT current_user,current_database()`;
  if(identity[0]?.current_user!=='srv_dataqore_app'||identity[0]?.current_database!=='dataqore_app')throw Error('Restricted runtime account required.');
  const count=await db.user.count();
  await db.schedule.count();
  await db.qualitySettings.findUniqueOrThrow({ where: { id: true } });
  console.log('Runtime database access verified. Administrator records: '+count+'.');
} catch(error) {
  console.error(databaseFailure(error));process.exitCode=1;
} finally {await db?.$disconnect();}
