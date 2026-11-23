# Compose project name; override with `make up PROJECT=...` if needed.
PROJECT ?= $(notdir $(CURDIR))-cms
COMPOSE = docker compose -p $(PROJECT)

.PHONY: up down restart reseed logs

up:
	$(COMPOSE) up --build -d

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) restart

# Wipes the database (and uploads/schema-state) volumes so the next start
# re-applies schemas and re-seeds from scratch. Destroys ALL data, including
# anything added outside the seeds. Never run against data you want to keep.
reseed:
	$(COMPOSE) down -v
	$(COMPOSE) up --build -d

logs:
	$(COMPOSE) logs -f
