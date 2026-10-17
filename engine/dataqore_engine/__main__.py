"""python -m dataqore_engine api|worker|openapi."""
import argparse
import json
from pathlib import Path

from .settings import load_settings


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command",choices=("api","worker","openapi"))
    parser.add_argument("--output",default="docs/openapi-engine.json")
    args=parser.parse_args()
    if args.command=="worker":
        from .worker import main as worker_main
        return worker_main()
    from .api import create_app
    if args.command=="openapi":
        # Exportação não acessa Postgres nem precisa dos segredos de execução.
        from cryptography.fernet import Fernet
        from .settings import Settings
        settings=Settings("postgresql+psycopg://srv_dataqore_engine@localhost/dataqore_engine",
            "openapi-export-placeholder",Fernet.generate_key().decode())
        app=create_app(settings)
        path=Path(args.output)
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(json.dumps(app.openapi(),ensure_ascii=False,indent=2)+"\n")
        app.state.engine.dispose()
        print(f"OpenAPI exportado em {path}")
        return 0
    import uvicorn
    uvicorn.run(create_app(load_settings()),host="127.0.0.1",port=8000,access_log=False)
    return 0


if __name__=="__main__":
    raise SystemExit(main())
