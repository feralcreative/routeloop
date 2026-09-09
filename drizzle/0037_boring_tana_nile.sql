CREATE TABLE "announced_releases" (
	"id" varchar(120) PRIMARY KEY NOT NULL,
	"announced_at" timestamp DEFAULT now() NOT NULL
);
