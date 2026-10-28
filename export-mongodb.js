require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { MongoClient, BSON: { EJSON } } = require("mongodb");

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function main() {
  const source = argValue("--source", "production").toLowerCase();
  if (!["production", "development"].includes(source)) {
    throw new Error('Use --source production or --source development.');
  }

  const uri = process.env[`MONGODB_${source.toUpperCase()}_URI`];
  const dbName = process.env[`MONGODB_${source.toUpperCase()}_DB`];
  const prefix = process.env.COLLECTION_PREFIX;

  if (!uri || uri.includes("<") || !dbName || !prefix) {
    throw new Error(
      `Check .env: MONGODB_${source.toUpperCase()}_URI, ` +
      `MONGODB_${source.toUpperCase()}_DB, and COLLECTION_PREFIX are required.`
    );
  }

  const exportRoot = path.resolve(process.env.EXPORT_DIR || "./exports");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(exportRoot, `${safeName(prefix)}-${source}-${timestamp}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(dbName);
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map(c => c.name)
      .filter(name => name.startsWith(prefix))
      .sort();

    if (!names.length) {
      console.log(`No collections starting with "${prefix}" found in ${source}/${dbName}.`);
      fs.rmSync(outputDir, { recursive: true, force: true });
      return;
    }

    const manifest = {
      exportedAt: new Date().toISOString(),
      source,
      database: dbName,
      collectionPrefix: prefix,
      collections: []
    };

    for (const name of names) {
      const docs = await db.collection(name).find({}).toArray();
      const file = path.join(outputDir, `${safeName(name)}.json`);
      fs.writeFileSync(file, EJSON.stringify(docs, null, 2, { relaxed: false }) + "\n", "utf8");
      manifest.collections.push({ name, documentCount: docs.length, file: path.basename(file) });
      console.log(`Exported ${name}: ${docs.length} document(s)`);
    }

    fs.writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`\nExport complete: ${outputDir}`);
    console.log(`Collections exported: ${manifest.collections.length}`);
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error("Export failed:", err.message);
  process.exitCode = 1;
});
