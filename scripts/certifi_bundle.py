"""Authenticated certifi CA update and narrowly derived pip wheel.

The derived wheel is a Vivary overlay, not an upstream pip release. Keep pip's
vendored import rewrites and all other packages unchanged. No network or install.
"""

import base64
import csv
import hashlib
import io
from pathlib import Path
import re
import ssl
import zipfile

CERTIFI_VERSION = "2026.10.23"
CERTIFI_WHEEL = "certifi-2026.10.23-py3-none-any.whl"
CERTIFI_URL = "https://files.pythonhosted.org/packages/32/d1/a3652fe2c19134d0d15922177821d863cbd7e842d53a21bbe7e8e3a1b5ac/" + CERTIFI_WHEEL
CERTIFI_SIZE = 135082
CERTIFI_SHA256 = "e9b54de76e530bb6cf0ccd036787103acb58fd42ba930ea8bf948ddbaa2f61d1"
CERTIFI_CA_SHA256 = "2ef52ad56b4803e264045c915e55c236cbfa045b84b81efefc218a19eb44bd2b"
PIP_WHEEL = "pip-26.2.2-py3-none-any.whl"
PIP_SHA256 = "fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70"
# G3 retains the existing policy. C1/C3 follow certifi's October 23 removal;
# their removal is not a claim of compromise or exploitation.
EXCLUDED_CA_SHA256 = frozenset({
    "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b",
    "125609aa301da0a249b97a8239cb6a34216f44dcac9f3954b14292f2e8c8608f",
    "bc4d809b15189d78db3e1d8cf4f9726a795da1643ca5f1358e1ddb0edc0d7eb3",
})


def filtered_ca_bytes(source):
    pems = re.findall(rb"-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----", source)
    kept = [pem for pem in pems
            if hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem.decode("ascii"))).hexdigest()
            not in EXCLUDED_CA_SHA256]
    if not kept:
        raise ValueError("CA bundle must retain certificates")
    return b"\n".join(kept) + b"\n"


def verify_certifi(data):
    if len(data) != CERTIFI_SIZE or hashlib.sha256(data).hexdigest() != CERTIFI_SHA256:
        raise ValueError("certifi wheel differs from the authenticated 2026.10.23 artifact")


def patched_pip_bytes(pip_bytes, certifi_bytes):
    if hashlib.sha256(pip_bytes).hexdigest() != PIP_SHA256:
        raise ValueError("pip input differs from the authenticated upstream wheel")
    verify_certifi(certifi_bytes)
    with zipfile.ZipFile(io.BytesIO(pip_bytes)) as pip, zipfile.ZipFile(io.BytesIO(certifi_bytes)) as certifi:
        members = {item.filename: pip.read(item) for item in pip.infolist()}
        if len(members) != len(pip.infolist()):
            raise ValueError("Duplicate wheel member")
        for name in ("__init__.py", "cacert.pem"):
            members["pip/_vendor/certifi/" + name] = certifi.read("certifi/" + name)
        vendor = "pip/_vendor/vendor.txt"
        if members[vendor].count(b"certifi==2026.10.19") != 1:
            raise ValueError("Unexpected pip certifi vendor pin")
        members[vendor] = members[vendor].replace(b"certifi==2026.10.19", b"certifi==2026.10.23")
        record = "pip-26.2.2.dist-info/RECORD"
        rows = []
        for name, data in members.items():
            digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode("ascii")
            rows.append((name, "", "") if name == record else (name, "sha256=" + digest, str(len(data))))
        output = io.StringIO(newline="")
        csv.writer(output, lineterminator="\n").writerows(rows)
        members[record] = output.getvalue().encode("utf-8")
        result = io.BytesIO()
        with zipfile.ZipFile(result, "w") as derived:
            derived.comment = pip.comment
            for item in pip.infolist():
                derived.writestr(item, members[item.filename])
        return result.getvalue()


def prepare_pip(pip_wheel, certifi_wheel, target):
    pip_wheel, certifi_wheel, target = map(Path, (pip_wheel, certifi_wheel, target))
    data = patched_pip_bytes(pip_wheel.read_bytes(), certifi_wheel.read_bytes())
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise ValueError("Derived pip destination must be a regular file")
    if target.exists():
        if target.read_bytes() != data:
            raise ValueError("Refusing changed derived pip wheel")
    else:
        with target.open("xb") as output:
            output.write(data)
    return target
