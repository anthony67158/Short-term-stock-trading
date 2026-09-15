from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from pydantic import Field, SecretStr

from platform_app.config import settings
from platform_app.contracts.base import Contract, Envelope
from platform_app.modules.identity import service
from platform_app.modules.identity.models import User

router = APIRouter(prefix="/api/v1", tags=["identity"])
COOKIE = "platform_session"


class LoginInput(Contract):
    username: str = Field(min_length=1, max_length=80)
    password: SecretStr = Field(min_length=1, max_length=256)


class UserView(Contract):
    id: str
    username: str


def current_user(request: Request) -> User:
    return service.authenticate(request.cookies.get(COOKIE))


CurrentUser = Annotated[User, Depends(current_user)]


@router.post("/sessions", response_model=Envelope[UserView])
def sign_in(body: LoginInput, request: Request, response: Response):
    peer = request.client.host if request.client else "unknown"
    user, token = service.login(body.username, body.password.get_secret_value(), peer)
    response.set_cookie(
        COOKIE, token, httponly=True, secure=settings().cookie_secure,
        samesite="strict", max_age=43200, path="/",
    )
    return Envelope(data=UserView.model_validate(user))


@router.get("/sessions/current", response_model=Envelope[UserView])
def session_info(user: CurrentUser):
    return Envelope(data=UserView.model_validate(user))


@router.delete("/sessions/current", status_code=204)
def sign_out(request: Request, response: Response, user: CurrentUser):
    service.logout(request.cookies[COOKIE])
    response.delete_cookie(COOKIE, path="/")
