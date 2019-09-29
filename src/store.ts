import { IDbSchema } from "./db/schema/dbschema";
import { SQLite3 } from "./db/sqlite3";
import { Postgres } from "./db/postgres";
import { Log } from "./log";
import { MxBridgeConfigDatabase } from "./config";
import { DbUserStore } from "./db/userstore";
import { DbChanStore } from "./db/chanstore";
import { DbPuppetStore } from "./db/puppetstore";
import { DbEventStore } from "./db/eventstore";
import { IDatabaseConnector } from "./db/connector";
const log = new Log("Store");

export const CURRENT_SCHEMA = 6;

type GetSchemaClass = (version: number) => IDbSchema;

export class Store {
	public db: IDatabaseConnector;
	private pChanStore: DbChanStore;
	private pUserStore: DbUserStore;
	private pPuppetStore: DbPuppetStore;
	private pEventStore: DbEventStore;

	constructor(private config: MxBridgeConfigDatabase) { }

	get chanStore() {
		return this.pChanStore;
	}

	get userStore() {
		return this.pUserStore;
	}

	get puppetStore() {
		return this.pPuppetStore;
	}

	get eventStore() {
		return this.pEventStore;
	}

	public async init(
		overrideSchema: number = 0,
		table: string = "schema",
		getSchemaClass?: GetSchemaClass,
	): Promise<void> {
		log.info("Starting DB Init");
		await this.openDatabase();
		let version = await this.getSchemaVersion(table);
		const targetSchema = overrideSchema || CURRENT_SCHEMA;
		log.info(`Database schema version is ${version}, latest version is ${targetSchema}`);
		while (version < targetSchema) {
			version++;
			let schemaClass;
			if (getSchemaClass) {
				schemaClass = getSchemaClass(version);
			} else {
				schemaClass = require(`./db/schema/v${version}.js`).Schema;
			}
			const schema = new schemaClass();
			log.info(`Updating database to v${version}, "${schema.description}"`);
			try {
				await schema.run(this);
				log.info("Updated database to version ", version);
			} catch (ex) {
				log.error("Couldn't update database to schema ", version);
				log.error(ex);
				log.info("Rolling back to version ", version - 1);
				try {
					await schema.rollBack(this);
				} catch (ex) {
					log.error(ex);
					throw Error("Failure to update to latest schema. And failed to rollback.");
				}
				throw Error("Failure to update to latest schema.");
			}
			await this.setSchemaVersion(version, table);
		}
	}

	public async close() {
		await this.db.Close();
	}

	public async createTable(statement: string, tablename: string) {
		try {
			if (this.db.type !== "postgres") {
				statement = statement.replace(/SERIAL PRIMARY KEY/g, "INTEGER  PRIMARY KEY AUTOINCREMENT");
			}
			await this.db.Exec(statement);
			log.info("Created table", tablename);
		} catch (err) {
			throw new Error(`Error creating '${tablename}': ${err}`);
		}
	}

	private async getSchemaVersion(table: string = "schema"): Promise<number> {
		log.silly(`_get_${table}_version`);
		let version = 0;
		try {
			// insecurely adding the table as it is in-code
			const versionReply = await this.db.Get(`SELECT version FROM ${table}`);
			version = versionReply!.version as number;
		} catch (er) {
			log.warn("Couldn't fetch schema version, defaulting to 0");
		}
		return version;
	}

	private async setSchemaVersion(ver: number, table: string = "schema"): Promise<void> {
		log.silly(`_set_${table}_version => `, ver);
		// insecurely adding the table as it is in-code
		await this.db.Run(
			`
			UPDATE ${table}
			SET version = $ver
			`, {ver},
		);
	}

	private async openDatabase(): Promise<void|Error> {
		if (this.config.connString) {
			log.info("connString present in config, using postgres");
			this.db = new Postgres(this.config.connString);
		} else if (this.config.filename) {
			log.info("Filename present in config, using sqlite");
			this.db = new SQLite3(this.config.filename);
		}
		try {
			this.db.Open();
			this.pChanStore = new DbChanStore(this.db);
			this.pUserStore = new DbUserStore(this.db);
			this.pPuppetStore = new DbPuppetStore(this.db);
			this.pEventStore = new DbEventStore(this.db);
		} catch (ex) {
			log.error("Error opening database:", ex);
			throw new Error("Couldn't open database. The appservice won't be able to continue.");
		}
	}
}
