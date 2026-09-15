"""Curated exchange facts required for historical market identity and coverage."""

OFFICIAL_CODE_MIGRATIONS = (
    {
        "source_code": "000022.SZ",
        "canonical_source_code": "001872.SZ",
        "instrument_id": "SZ.001872",
        "effective_from": "19930505",
        "effective_to": "20181225",
        "reason": "SECURITY_CODE_CHANGE",
        "source_urls": (
            "https://disc.static.szse.cn/disc/disk01/finalpage/"
            "2018-12-14/0349c7a4-31d9-4a0f-8c54-3626cc8bca63.PDF",
        ),
    },
    {
        "source_code": "000043.SZ",
        "canonical_source_code": "001914.SZ",
        "instrument_id": "SZ.001914",
        "effective_from": "19940928",
        "effective_to": "20191215",
        "reason": "SECURITY_CODE_CHANGE",
        "source_urls": (
            "https://disc.static.szse.cn/download/disc/disk02/finalpage/"
            "2019-12-16/a5a3d55e-cc2e-42e6-91c1-ea98235594fb.PDF",
        ),
    },
    {
        "source_code": "300114.SZ",
        "canonical_source_code": "302132.SZ",
        "instrument_id": "SZ.302132",
        "effective_from": "20100827",
        "effective_to": "20250216",
        "reason": "SECURITY_CODE_CHANGE",
        "source_urls": (
            "http://disc.static.szse.cn/download/disc/disk03/finalpage/"
            "2025-02-07/e2d8b9d3-879b-4587-9e1e-235ebf4c8a44.PDF",
        ),
    },
)

OFFICIAL_LISTING_STATUS_PERIODS = (
    {
        "instrument_id": "SZ.000950",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20170511",
        "effective_to": "20180828",
        "source_urls": (
            "https://www.szse.cn/disclosure/notice/t20170508_502037.html",
            "https://www.szse.cn/disclosure/notice/company/t20180820_554288.html",
        ),
    },
    {
        "instrument_id": "SZ.000629",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20170505",
        "effective_to": "20180824",
        "source_urls": (
            "https://www.szse.cn/disclosure/notice/company/t20180815_554224.html",
        ),
    },
    {
        "instrument_id": "SZ.300372",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20160906",
        "effective_to": "20170717",
        "source_urls": (
            "https://www.szse.cn/disclosure/notice/general/t20170623_502081.html",
        ),
    },
    {
        "instrument_id": "SZ.000155",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20160510",
        "effective_to": "20171218",
        "source_urls": (
            "https://disc.static.szse.cn/disc/disk01/finalpage/"
            "2016-06-14/a79e7256-e9c8-43ec-99b2-6f739f169d7b.PDF",
            "http://static.cninfo.com.cn/finalpage/2017-12-09/1204206641.PDF",
        ),
    },
    {
        "instrument_id": "SH.600710",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20160420",
        "effective_to": "20170731",
        "source_urls": (
            "https://www.sse.com.cn/disclosure/listedinfo/announcement/"
            "c/2017-07-25/600710_20170725_1.pdf",
        ),
    },
    {
        "instrument_id": "SH.600732",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20160408",
        "effective_to": "20170606",
        "source_urls": (
            "http://www.sse.com.cn/disclosure/announcement/general/c/c_20160401_4071753.shtml",
            "http://static.sse.com.cn/disclosure/listedinfo/announcement/"
            "c/2017-06-06/600732_20170606_1.pdf",
        ),
    },
    {
        "instrument_id": "SH.600656",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20150528",
        "effective_to": "20160329",
        "source_urls": (
            "https://www.sse.com.cn/aboutus/mediacenter/hotandd/c/c_20160321_4061432.shtml",
            "https://www.sse.com.cn/lawandrules/sselawsrules2025/repeal/"
            "rules/c/c_20210601_10784972.shtml",
        ),
    },
    {
        "instrument_id": "SZ.000033",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20150521",
        "effective_to": "20170524",
        "source_urls": ("https://www.szse.cn/aboutus/trends/news/t20170517_518976.html",),
    },
    {
        "instrument_id": "SH.600074",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20190524",
        "effective_to": "20200410",
        "source_urls": (
            "http://www.sse.com.cn/disclosure/announcement/listing/stock/"
            "c/c_20190517_72734475.shtml",
            "http://www.sse.com.cn/disclosure/listedinfo/announcement/"
            "c/2020-04-02/600074_20200402_1.pdf",
        ),
    },
    {
        "instrument_id": "SH.600610",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20190719",
        "effective_to": "20200817",
        "source_urls": (
            "http://static.sse.com.cn/disclosure/listedinfo/announcement/"
            "c/2020-01-18/600610_20200118_1.pdf",
            "http://www.sse.com.cn/disclosure/announcement/listing/stock/"
            "c/c_20200810_78949453.shtml",
        ),
    },
    {
        "instrument_id": "SZ.000670",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20200407",
        "effective_to": "20220822",
        "source_urls": (
            "http://www.szse.cn/certificate/maind/maindynamice/t20200403_575752.html",
            "https://www.szse.cn/disclosure/notice/t20220812_595353.html",
        ),
    },
    {
        "instrument_id": "SZ.000939",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20190513",
        "effective_to": "20201105",
        "source_urls": ("https://www.szse.cn/disclosure/notice/t20201028_582723.html",),
    },
    {
        "instrument_id": "SZ.000995",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20190513",
        "effective_to": "20201216",
        "source_urls": ("https://www.szse.cn/disclosure/notice/company/t20201208_583712.html",),
    },
    {
        "instrument_id": "SZ.002260",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20190515",
        "effective_to": "20220505",
        "source_urls": (
            "https://www.szse.cn/www/disclosure/supervision/measure/decision/t20220615_593865.html",
            "https://disc.static.szse.cn/download/disc/disk03/finalpage/"
            "2022-04-26/70cc42d7-56c8-47df-b222-9fe3e9a63fe0.PDF",
        ),
    },
    {
        "instrument_id": "SZ.002604",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20190515",
        "effective_to": "20200601",
        "source_urls": (
            "http://disc.static.szse.cn/download/disc/disk01/finalpage/"
            "2019-05-11/c297053e-b3c9-4873-84e5-e774c058009b.PDF",
            "http://disc.static.szse.cn/download/disc/disk02/finalpage/"
            "2020-05-23/67606e4a-44b2-4af0-8c1f-595b1a0945b6.PDF",
        ),
    },
    {
        "instrument_id": "SZ.300028",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20190513",
        "effective_to": "20200618",
        "source_urls": (
            "http://disc.static.szse.cn/download/disc/disk01/finalpage/"
            "2019-05-10/df0dd21f-2e88-4f42-80d7-602b444c6a7f.PDF",
            "http://disc.static.szse.cn/disc/disk02/finalpage/"
            "2020-06-17/e7bbc875-556c-4826-a28b-8beab4e89c3f.PDF",
        ),
    },
    {
        "instrument_id": "SZ.300104",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20190513",
        "effective_to": "20200605",
        "source_urls": (
            "https://www.szse.cn/certificate/secondb/GEMdynamice/t20190510_567086.html",
            "https://www.szse.cn/disclosure/notice/t20200514_577126.html",
        ),
    },
    {
        "instrument_id": "SZ.300216",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20190513",
        "effective_to": "20200805",
        "source_urls": (
            "https://disc.static.szse.cn/disc/disk02/finalpage/"
            "2020-06-05/cd2e49be-a05e-42ca-8b90-be72456ab8ea.PDF",
            "http://disc.static.szse.cn/download/disc/disk02/finalpage/"
            "2020-07-14/cfc9fc69-9544-42e7-8cda-a86cfb2cf7c1.PDF",
        ),
    },
)
